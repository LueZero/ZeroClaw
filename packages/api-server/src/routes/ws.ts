/**
 * WebSocket route — 前端即時通訊
 *
 * 連線：GET /ws  with ?token=<jwt>
 *
 * 客戶端訊息：WsClientMessage
 * 服務端訊息：WsServerMessage
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type {
  WsClientMessage,
  WsServerMessage,
  IncomingMessage,
} from '@zeroclaw/shared';
import { agentEventToWs, Errors } from '@zeroclaw/shared';
import type { AuthService } from '../auth/auth-service.js';
import type { SessionManager } from '../session/session-manager.js';

interface RegisterWsDeps {
  logger: Logger;
  auth: AuthService;
  sessions: SessionManager;
}

export async function registerWebSocket(
  app: FastifyInstance,
  deps: RegisterWsDeps,
): Promise<void> {
  app.get('/ws', { websocket: true }, async (socket, req: FastifyRequest) => {
    const token = (req.query as { token?: string }).token;
    if (!token) {
      socket.close(4001, 'token required');
      return;
    }
    let ctx: import('@zeroclaw/shared').AuthContext;
    try {
      ctx = await deps.auth.verifyToken(token);
    } catch {
      socket.close(4001, 'invalid token');
      return;
    }

    const subscriptions = new Set<string>();
    const aborts = new Map<string, AbortController>();

    function safeSend(msg: WsServerMessage): void {
      if (socket.readyState === 1) socket.send(JSON.stringify(msg));
    }

    socket.on('message', async (raw: Buffer) => {
      let parsed: WsClientMessage;
      try {
        parsed = JSON.parse(raw.toString('utf8')) as WsClientMessage;
      } catch {
        return;
      }

      try {
        await dispatch(parsed);
      } catch (e) {
        const err = e as Error;
        safeSend({
          type: 'agent.error',
          sessionId: 'sessionId' in parsed ? parsed.sessionId : '',
          error: { code: 'INTERNAL_ERROR', message: err.message },
        });
      }
    });

    socket.on('close', () => {
      for (const ac of aborts.values()) ac.abort();
      aborts.clear();
      subscriptions.clear();
    });

    async function dispatch(msg: WsClientMessage): Promise<void> {
      switch (msg.type) {
        case 'subscribe': {
          await assertOwn(msg.sessionId);
          subscriptions.add(msg.sessionId);
          safeSend({ type: 'subscribed', sessionId: msg.sessionId });
          return;
        }
        case 'unsubscribe': {
          subscriptions.delete(msg.sessionId);
          safeSend({ type: 'unsubscribed', sessionId: msg.sessionId });
          return;
        }
        case 'user.message': {
          await assertOwn(msg.sessionId);
          await runAgent(msg);
          return;
        }
        case 'user.abort': {
          aborts.get(msg.sessionId)?.abort();
          await deps.sessions.abort(msg.sessionId);
          return;
        }
        case 'user.switchAgent': {
          await assertOwn(msg.sessionId);
          const result = await deps.sessions.switchAgent(
            msg.sessionId,
            msg.agentId,
            msg.subAgent,
          );
          safeSend({
            type: 'session.agentSwitched',
            sessionId: msg.sessionId,
            previousAgent: result.agentId,
            currentAgent: msg.agentId,
          });
          return;
        }
        case 'user.approval': {
          await assertOwn(msg.sessionId);
          await deps.sessions.resolveApproval(
            msg.sessionId,
            msg.requestId,
            msg.approved,
          );
          return;
        }
        case 'user.elicitation': {
          await assertOwn(msg.sessionId);
          await deps.sessions.resolveElicitation(
            msg.sessionId,
            msg.requestId,
            msg.answer,
          );
          return;
        }
      }
    }

    async function assertOwn(sessionId: string): Promise<void> {
      const s = await deps.sessions.get(sessionId);
      if (s.userId !== ctx.userId && ctx.role !== 'admin') {
        throw Errors.forbidden();
      }
    }

    async function runAgent(
      msg: Extract<WsClientMessage, { type: 'user.message' }>,
    ): Promise<void> {
      // 中止舊的（如有）
      aborts.get(msg.sessionId)?.abort();
      const ac = new AbortController();
      aborts.set(msg.sessionId, ac);

      const incoming: IncomingMessage = {
        platform: 'web',
        platformUserId: ctx.userId,
        platformChatId: ctx.userId,
        text: msg.text,
        attachments: msg.attachments,
        raw: msg,
        receivedAt: new Date(),
      };

      try {
        for await (const event of deps.sessions.handleMessage(
          msg.sessionId,
          incoming,
          ac.signal,
        )) {
          safeSend(agentEventToWs(msg.sessionId, event));
        }
      } catch (e) {
        const err = e as Error;
        safeSend({
          type: 'agent.error',
          sessionId: msg.sessionId,
          error: { code: 'INTERNAL_ERROR', message: err.message },
        });
      } finally {
        aborts.delete(msg.sessionId);
      }
    }
  });
}
