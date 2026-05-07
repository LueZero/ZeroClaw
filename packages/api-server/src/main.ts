/**
 * Application bootstrap
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { PlatformError } from '@zeroclaw/shared';

import { loadEnv } from './config/env.js';
import { createGroupsRegistry } from './config/groups-loader.js';
import { createAgentRegistry } from './agent/agent-registry.js';
import { createContainerManager } from './container/container-manager.js';
import { createDb } from './db/index.js';
import { createSessionManager } from './session/session-manager.js';
import { createAuthService } from './auth/auth-service.js';
import { createMessagingRegistry } from './messaging/adapter.js';
import { processIncomingMessages } from './messaging/message-processor.js';
import { createPairingService } from './messaging/pairing.js';
import { createAutoRouter } from './session/auto-router.js';
import { createTelegramAdapter } from './messaging/telegram-adapter.js';
import { createWhatsAppAdapter } from './messaging/whatsapp-adapter.js';
import { createDiscordAdapter } from './messaging/discord-adapter.js';
import { createSlackAdapter } from './messaging/slack-adapter.js';
import { createTeamsAdapter } from './messaging/teams-adapter.js';
import { registerRoutes } from './routes/rest.js';
import { registerWebhooks } from './routes/webhooks.js';
import { registerWebSocket } from './routes/ws.js';

export async function buildApp() {
  const env = loadEnv();
  const logger = pino({ level: env.LOG_LEVEL });

  // ── 配置與註冊表 ──
  const agents = await createAgentRegistry(resolve(env.AGENTS_DIR));
  const db = await createDb({
    driver: env.DB_DRIVER,
    databaseUrl: env.DATABASE_URL,
    sqlitePath: resolve(env.SQLITE_PATH),
  });
  const groups = await createGroupsRegistry(resolve(env.GROUPS_FILE), db);
  const containers = createContainerManager({
    env,
    logger: logger.child({ mod: 'container' }),
    agentsDir: resolve(env.AGENTS_DIR),
    db,
  });

  // Adopt persisted containers from DB
  await containers.adoptFromDb();
  containers.startGc();

  const auth = createAuthService({
    db,
    jwtSecret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
  });

  const autoRouter = createAutoRouter({
    logger: logger.child({ mod: 'auto-router' }),
    openaiApiKey: env.OPENAI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
  });

  const sessions = createSessionManager({
    logger: logger.child({ mod: 'session' }),
    groups,
    agents,
    containers,
    db,
    autoRouter,
    env,
  });

  // T-3: Session lifecycle (idle timeout, retention cleanup)
  sessions.startLifecycle();

  // ── 容器健康監控：容器 unhealthy 時記錄（session 遷移在 handleMessage 時自動觸發）──
  if ('onUnhealthy' in containers) {
    (containers as unknown as { onUnhealthy: (h: (cid: string, gid: string, aid: string) => void) => void })
      .onUnhealthy((containerId, groupId, agentId) => {
        logger.error(
          { containerId, groupId, agentId },
          'Container unhealthy — affected sessions will auto-migrate on next message',
        );
      });
  }

  // ── 通訊平台 ──
  const messaging = createMessagingRegistry();
  if (env.TELEGRAM_BOT_TOKEN) {
    messaging.register(
      createTelegramAdapter({
        botToken: env.TELEGRAM_BOT_TOKEN,
        webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
        mode: env.TELEGRAM_MODE,
      }),
    );
    logger.info({ mode: env.TELEGRAM_MODE }, 'Telegram adapter registered');
  }
  if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_VERIFY_TOKEN) {
    messaging.register(
      createWhatsAppAdapter({
        accessToken: env.WHATSAPP_ACCESS_TOKEN,
        verifyToken: env.WHATSAPP_VERIFY_TOKEN,
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
        appSecret: env.WHATSAPP_APP_SECRET,
      }),
    );
    logger.info('WhatsApp adapter registered');
  }
  if (env.DISCORD_BOT_TOKEN && env.DISCORD_PUBLIC_KEY) {
    messaging.register(
      createDiscordAdapter({
        botToken: env.DISCORD_BOT_TOKEN,
        publicKey: env.DISCORD_PUBLIC_KEY,
        appId: env.DISCORD_APP_ID,
        botId: env.DISCORD_BOT_ID,
        mode: env.DISCORD_MODE,
      }),
    );
    logger.info({ mode: env.DISCORD_MODE }, 'Discord adapter registered');
  }
  if (env.SLACK_BOT_TOKEN && env.SLACK_SIGNING_SECRET) {
    messaging.register(
      createSlackAdapter({
        botToken: env.SLACK_BOT_TOKEN,
        signingSecret: env.SLACK_SIGNING_SECRET,
      }),
    );
    logger.info({ mode: env.SLACK_MODE }, 'Slack adapter registered');
  }
  if (env.TEAMS_APP_ID && env.TEAMS_APP_PASSWORD) {
    messaging.register(
      createTeamsAdapter({
        appId: env.TEAMS_APP_ID,
        appPassword: env.TEAMS_APP_PASSWORD,
        tenantId: env.TEAMS_APP_TENANT_ID,
      }),
    );
    logger.info('Teams adapter registered');
  }

  // ── Fastify ──
  // Cast loggerInstance: pino's Logger generic does not structurally satisfy
  // Fastify v5's FastifyBaseLogger (missing msgPrefix in the static type),
  // but at runtime pino implements all required methods. We pin the
  // FastifyInstance to the default generic so downstream plugins type-check.
  const app: FastifyInstance = Fastify({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loggerInstance: logger as any,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof PlatformError) {
      return reply.status(err.statusCode).send(err.toJSON());
    }
    logger.error({ err }, 'unhandled error');
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ code: 'INTERNAL_ERROR', message });
  });

  // pairing service 供 webhook 路徑 + polling adapter + REST 共用
  const pairingLogger = logger.child({ mod: 'pairing' });
  const pairing = createPairingService({ db, logger: pairingLogger });

  await registerRoutes(app, { auth, groups, agents, sessions, containers, db, pairing, messaging });
  await registerWebhooks(app, {
    logger: logger.child({ mod: 'webhook' }),
    messaging,
    auth,
    groups,
    sessions,
    db,
    pairing,
  });
  await registerWebSocket(app, {
    logger: logger.child({ mod: 'ws' }),
    auth,
    sessions,
  });

  // ── SPA 靜態檔案服務（production 用）──
  // web-app build 後產出在 ../web-app/dist/，API server 可同時服務前端
  const webAppDist = resolve(import.meta.dirname ?? __dirname, '../../web-app/dist');
  if (existsSync(webAppDist)) {
    await app.register(fastifyStatic, {
      root: webAppDist,
      prefix: '/',
      wildcard: false,       // 不攔 API 路由
      decorateReply: false,  // 避免與其他 plugin 衝突
    });
    // SPA fallback：非 API/ws/webhooks 路徑都返回 index.html
    app.setNotFoundHandler(async (req, reply) => {
      // API / webhooks 路徑返回標準 404 JSON
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws') || req.url.startsWith('/webhooks/')) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Route not found' });
      }
      return reply.sendFile('index.html', webAppDist);
    });
    logger.info({ path: webAppDist }, 'Serving web-app static files with SPA fallback');
  }

  // ── 啟動主動連線 adapter（polling / gateway）──
  // 受影響平台：Telegram（polling 預設）；Webhook 類 adapter 不實作 start 會被跳過
  const messagingLogger = logger.child({ mod: 'messaging' });
  for (const adapter of messaging.list()) {
    if (typeof adapter.start === 'function') {
      await adapter.start({
        logger: messagingLogger.child({ platform: adapter.platform }),
        onMessages: (messages) =>
          processIncomingMessages(
            { logger: messagingLogger, auth, groups, sessions, db, pairing },
            adapter,
            messages,
          ),
      });
    }
  }

  // 優雅關閉
  const shutdown = async () => {
    logger.info('Shutting down...');
    sessions.stopLifecycle();
    for (const adapter of messaging.list()) {
      if (typeof adapter.stop === 'function') {
        try {
          await adapter.stop();
        } catch (err) {
          logger.warn({ err, platform: adapter.platform }, 'adapter.stop failed');
        }
      }
    }
    await containers.dispose();
    db.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, env, logger };
}

export async function main(): Promise<void> {
  const { app, env, logger } = await buildApp();
  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ host: env.HOST, port: env.PORT }, 'API server listening');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
