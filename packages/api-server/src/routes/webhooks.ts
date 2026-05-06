/**
 * Webhook routes — 通訊平台 webhook 入口
 *
 * 對每個已註冊的 MessagingAdapter，掛上：
 *   GET  /webhooks/:platform   → adapter.verifyWebhook()
 *   POST /webhooks/:platform   → adapter.handleWebhook() → 路由到 SessionManager
 *
 * 訊息處理共用 messaging/message-processor.ts；polling adapter（如 Telegram）
 * 也呼叫同一支 processIncomingMessages，路由語意一致。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { Platform } from '@zeroclaw/shared';
import type { MessagingRegistry } from '../messaging/adapter.js';
import { processIncomingMessages } from '../messaging/message-processor.js';
import type { PairingService } from '../messaging/pairing.js';
import type { AuthService } from '../auth/auth-service.js';
import type { GroupsRegistry } from '../config/groups-loader.js';
import type { SessionManager } from '../session/session-manager.js';
import type { DbStore } from '../db/db-store.js';

interface RegisterWebhooksDeps {
  logger: Logger;
  messaging: MessagingRegistry;
  auth: AuthService;
  groups: GroupsRegistry;
  sessions: SessionManager;
  db: DbStore;
  pairing: PairingService;
}

export async function registerWebhooks(
  app: FastifyInstance,
  deps: RegisterWebhooksDeps,
): Promise<void> {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body: Buffer, done) => {
      try {
        const json = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
        // 將 raw body 也存到 request 上以便 adapter 驗章
        (_req as unknown as { rawBody: Buffer }).rawBody = body;
        done(null, json);
      } catch (e) {
        done(e as Error, undefined);
      }
    },
  );

  app.get<{ Params: { platform: string } }>(
    '/webhooks/:platform',
    async (req, reply) => {
      const platform = req.params.platform as Platform;
      const adapter = deps.messaging.get(platform);
      if (!adapter || !adapter.verifyWebhook) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const result = adapter.verifyWebhook(buildWebhookRequest(req));
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { platform: string } }>(
    '/webhooks/:platform',
    async (req, reply) => {
      const platform = req.params.platform as Platform;
      const adapter = deps.messaging.get(platform);
      if (!adapter) return reply.code(404).send({ error: 'Not found' });

      const result = await adapter.handleWebhook(buildWebhookRequest(req));

      // 共用的訊息處理
      await processIncomingMessages(deps, adapter, result.messages);

      return reply.code(result.status).send(result.body ?? { ok: true });
    },
  );
}

function buildWebhookRequest(req: FastifyRequest) {
  return {
    headers: req.headers as Record<string, string | string[] | undefined>,
    rawBody:
      (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(''),
    body: req.body,
    query: (req.query ?? {}) as Record<string, string | undefined>,
  };
}
