/**
 * REST routes
 *  GET  /healthz
 *  GET  /api/groups                     列出可見群組
 *  GET  /api/groups/:groupId/agents     列出群組內可選代理人
 *  POST /api/auth/dev-login             開發用快速登入
 *  POST /api/sessions                   建立 session
 *  GET  /api/sessions                   列出我的 session
 *  GET  /api/sessions/:id               取得 session 詳情
 *  GET  /api/sessions/:id/messages      取得歷史訊息
 *  POST /api/sessions/:id/switchAgent   切換代理人
 *  DELETE /api/sessions/:id             刪除 session
 *  POST /api/admin/reload               重載 groups + agents（admin only）
 *  GET  /api/admin/containers           列出容器狀態（admin only）
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Errors } from '@zeroclaw/shared';
import type { AuthContext } from '@zeroclaw/shared';
import type { AuthService } from '../auth/auth-service.js';
import type { AgentRegistry } from '../agent/agent-registry.js';
import type { GroupsRegistry } from '../config/groups-loader.js';
import type { ContainerManager } from '../container/container-manager.js';
import type { SessionManager } from '../session/session-manager.js';
import type { DbStore } from '../db/db-store.js';
import type { PairingService, CreatePairingInput } from '../messaging/pairing.js';
import type { MessagingRegistry } from '../messaging/adapter.js';
import type { Platform } from '@zeroclaw/shared';

interface RegisterRoutesDeps {
  auth: AuthService;
  groups: GroupsRegistry;
  agents: AgentRegistry;
  sessions: SessionManager;
  containers: ContainerManager;
  db: DbStore;
  pairing: PairingService;
  messaging: MessagingRegistry;
}

export async function registerRoutes(
  app: FastifyInstance,
  deps: RegisterRoutesDeps,
): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));

  // ─── helper: requireAuth ───
  async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw Errors.unauthorized();
    }
    return deps.auth.verifyToken(header.slice(7));
  }

  function requireAdmin(ctx: AuthContext): void {
    if (ctx.role !== 'admin') throw Errors.forbidden('admin only');
  }

  // ─── auth ───
  app.post('/api/auth/dev-login', async (req) => {
    const body = z
      .object({
        userId: z.string().min(1),
        role: z.enum(['admin', 'member', 'guest']).default('member'),
        displayName: z.string().optional(),
      })
      .parse(req.body);
    await deps.db.upsertUser({
      id: body.userId,
      role: body.role,
      displayName: body.displayName ?? body.userId,
      externalIds: {
        web: body.userId,
        telegram: undefined,
        whatsapp: undefined,
        discord: undefined,
        slack: undefined,
        teams: undefined,
      },
      createdAt: new Date(),
    });
    const token = await deps.auth.signToken({ userId: body.userId, role: body.role });
    return { token };
  });

  // ─── groups ───
  app.get('/api/groups', async (req) => {
    await requireAuth(req);
    return deps.groups.list().map((g) => ({
      id: g.id,
      displayName: g.displayName,
      description: g.description,
      icon: g.icon,
      defaultAgent: g.defaultAgent,
      agents: g.agents,
    }));
  });

  app.get<{ Params: { groupId: string } }>(
    '/api/groups/:groupId/agents',
    async (req) => {
      await requireAuth(req);
      const group = deps.groups.get(req.params.groupId);
      if (!group) throw Errors.groupNotFound(req.params.groupId);
      return group.agents
        .map((id) => deps.agents.tryGet(id))
        .filter((a) => a !== undefined)
        .map((a) => ({
          id: a!.id,
          sdk: a!.sdk,
          displayName: a!.displayName,
          description: a!.description,
          avatar: a!.avatar,
          subAgents: a!.subAgents,
          primaryAgent: a!.primaryAgent,
        }));
    },
  );

  // ─── sessions ───
  const CreateSessionBody = z.object({
    groupId: z.string(),
    agentId: z.string().optional(),
    title: z.string().optional(),
  });

  app.post('/api/sessions', async (req) => {
    const ctx = await requireAuth(req);
    const body = CreateSessionBody.parse(req.body);
    const session = await deps.sessions.createOrGet({
      userId: ctx.userId,
      groupId: body.groupId,
      agentId: body.agentId,
      platform: 'web',
      title: body.title,
    });
    return session;
  });

  app.get('/api/sessions', async (req) => {
    const ctx = await requireAuth(req);
    const groupId = (req.query as { groupId?: string }).groupId;
    const all = await deps.sessions.list(ctx.userId, groupId);
    // 預設過濾已過期的 session
    const includeExpired = (req.query as { includeExpired?: string }).includeExpired === 'true';
    return includeExpired ? all : all.filter((s) => s.status !== 'expired');
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    const ctx = await requireAuth(req);
    const s = await deps.sessions.get(req.params.id);
    if (s.userId !== ctx.userId && ctx.role !== 'admin') throw Errors.forbidden();
    return s;
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/messages', async (req) => {
    const ctx = await requireAuth(req);
    const s = await deps.sessions.get(req.params.id);
    if (s.userId !== ctx.userId && ctx.role !== 'admin') throw Errors.forbidden();
    const limit = Math.min(Number((req.query as { limit?: string }).limit) || 100, 500);
    return await deps.db.listMessages(req.params.id, limit);
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/switchAgent', async (req) => {
    const ctx = await requireAuth(req);
    const s = await deps.sessions.get(req.params.id);
    if (s.userId !== ctx.userId && ctx.role !== 'admin') throw Errors.forbidden();
    const body = z
      .object({ agentId: z.string(), subAgent: z.string().optional() })
      .parse(req.body);
    return await deps.sessions.switchAgent(req.params.id, body.agentId, body.subAgent);
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const ctx = await requireAuth(req);
    const s = await deps.sessions.get(req.params.id);
    if (s.userId !== ctx.userId && ctx.role !== 'admin') throw Errors.forbidden();
    await deps.sessions.delete(req.params.id);
    return reply.code(204).send();
  });

  // ─── admin ───
  app.post('/api/admin/reload', async (req) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    await deps.groups.reload();
    await deps.agents.reload();
    return { ok: true };
  });

  // ─── pairing (admin only) ───
  const PairingBody = z.object({
    groupId: z.string(),
    platform: z.string() as z.ZodType<Platform>,
    agentId: z.string().optional(),
    engageMode: z.enum(['pattern', 'mention', 'mention-sticky']).optional(),
    engagePattern: z.string().optional(),
    sessionMode: z.enum(['per-user', 'per-thread', 'shared', 'agent-shared']).optional(),
  });

  app.post('/api/pairings', async (req) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    const input = PairingBody.parse(req.body) as CreatePairingInput;
    if (!deps.groups.get(input.groupId)) throw Errors.groupNotFound(input.groupId);
    const record = await deps.pairing.create(input);
    return {
      code: record.code,
      groupId: record.groupId,
      platform: record.platform,
      agentId: record.agentId ?? null,
      engageMode: record.engageMode ?? null,
      sessionMode: record.sessionMode ?? null,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
    };
  });

  app.get<{ Params: { code: string } }>('/api/pairings/:code', async (req) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    const r = await deps.pairing.status(req.params.code);
    if (!r) throw Errors.notFound('pairing', req.params.code);
    return {
      code: r.code,
      groupId: r.groupId,
      platform: r.platform,
      agentId: r.agentId ?? null,
      status: r.status,
      consumedChatId: r.consumedChatId ?? null,
    };
  });

  // ─── admin: groups (dynamic override of yaml) ───
  // GET returns ALL groups (incl. disabled) merged with DB overrides.
  app.get('/api/admin/groups', async (req) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    const overrides = await deps.db.listGroupOverrides();
    const overrideMap = new Map(overrides.map((o) => [o.groupId, o]));
    return deps.groups.listAll().map((g) => ({
      id: g.id,
      displayName: g.displayName,
      description: g.description,
      icon: g.icon,
      enabled: g.enabled,
      agents: g.agents,
      defaultAgent: g.defaultAgent,
      baseImage: g.container.baseImage,
      maxSessions: g.container.maxSessions,
      mountAgentsDir: g.container.mountAgentsDir ?? false,
      cpuLimit: g.container.resources?.cpus ?? null,
      memoryLimit: g.container.resources?.memory ?? null,
      routingMode: g.routing.mode,
      routingFallback: g.routing.fallback,
      routingAutoClassifierModel: g.routing.autoClassifierModel,
      hasOverride: overrideMap.has(g.id),
      override: overrideMap.get(g.id) ?? null,
    }));
  });

  const GroupOverridePatch = z
    .object({
      displayName: z.string().min(1).optional(),
      description: z.string().optional(),
      icon: z.string().optional(),
      enabled: z.boolean().optional(),
      defaultAgent: z.string().optional(),
      maxSessions: z.number().int().positive().max(1000).optional(),
      routingMode: z.enum(['explicit', 'auto', 'round-robin']).optional(),
      routingFallback: z.string().nullable().optional(),
      routingAutoClassifierModel: z.string().nullable().optional(),
    })
    .strict();

  app.patch<{ Params: { id: string } }>('/api/admin/groups/:id', async (req, reply) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    const groupId = req.params.id;
    const exists = deps.groups.listAll().find((g) => g.id === groupId);
    if (!exists) throw Errors.groupNotFound(groupId);
    const patch = GroupOverridePatch.parse(req.body);

    const current = await deps.db.getGroupOverride(groupId);
    await deps.db.upsertGroupOverride({
      groupId,
      displayName: patch.displayName !== undefined ? patch.displayName : current?.displayName ?? null,
      description: patch.description !== undefined ? patch.description : current?.description ?? null,
      icon: patch.icon !== undefined ? patch.icon : current?.icon ?? null,
      enabled: patch.enabled !== undefined ? patch.enabled : current?.enabled ?? null,
      defaultAgent: patch.defaultAgent !== undefined ? patch.defaultAgent : current?.defaultAgent ?? null,
      maxSessions: patch.maxSessions !== undefined ? patch.maxSessions : current?.maxSessions ?? null,
      routingMode: patch.routingMode !== undefined ? patch.routingMode : current?.routingMode ?? null,
      routingFallback: 'routingFallback' in patch ? (patch.routingFallback ?? null) : current?.routingFallback ?? null,
      routingAutoClassifierModel: 'routingAutoClassifierModel' in patch ? (patch.routingAutoClassifierModel ?? null) : current?.routingAutoClassifierModel ?? null,
      updatedAt: new Date(),
    });
    await deps.groups.reload();
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>('/api/admin/groups/:id/override', async (req, reply) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    await deps.db.deleteGroupOverride(req.params.id);
    await deps.groups.reload();
    return reply.code(204).send();
  });

  // ─── admin: messaging-groups ───
  app.get('/api/admin/messaging-groups', async (req) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    return await deps.db.listMessagingGroups();
  });

  app.post('/api/admin/messaging-groups', async (req) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    const body = z.object({
      id: z.string().optional(),
      platform: z.string() as z.ZodType<Platform>,
      platformChatId: z.string(),
      isGroup: z.boolean().default(false),
      unknownSenderPolicy: z.enum(['allow', 'drop']).default('allow'),
    }).parse(req.body);
    const mg = await deps.db.upsertMessagingGroup({
      id: body.id ?? `mg-${Date.now()}`,
      platform: body.platform,
      platformChatId: body.platformChatId,
      isGroup: body.isGroup,
      unknownSenderPolicy: body.unknownSenderPolicy,
      deniedAt: null,
      createdAt: new Date(),
    });

    // Auto-seed default wiring (mirrors message-processor.ts logic)
    const firstGroup = deps.groups.list()[0];
    const defaultAgentId = firstGroup?.defaultAgent ?? firstGroup?.agents[0];
    if (firstGroup && defaultAgentId) {
      // supportsThreads depends on platform; treat discord/slack/teams as threaded
      const threadedPlatforms = ['discord', 'slack', 'teams'];
      const supportsThreads = threadedPlatforms.includes(body.platform);
      const engageMode = supportsThreads && body.isGroup ? 'mention-sticky' : 'pattern';
      await deps.db.addMessagingGroupAgent({
        messagingGroupId: mg.id,
        groupId: firstGroup.id,
        agentId: defaultAgentId,
        engageMode,
        engagePattern: engageMode === 'pattern' ? '.' : null,
        sessionMode: 'per-user',
        ignoredMessagePolicy: 'accumulate',
        createdAt: new Date(),
      });
    }

    return mg;
  });

  app.delete<{ Params: { mgId: string } }>('/api/admin/messaging-groups/:mgId', async (req, reply) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    await deps.db.deleteMessagingGroup(req.params.mgId);
    return reply.code(204).send();
  });

  app.patch<{ Params: { mgId: string } }>('/api/admin/messaging-groups/:mgId', async (req, reply) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    const patch = z.object({
      unknownSenderPolicy: z.enum(['allow', 'drop']).optional(),
      denied: z.boolean().optional(),
    }).parse(req.body);
    const deniedAt = patch.denied === true ? new Date().toISOString() : patch.denied === false ? null : undefined;
    await deps.db.updateMessagingGroup(req.params.mgId, {
      unknownSenderPolicy: patch.unknownSenderPolicy,
      ...(deniedAt !== undefined ? { deniedAt } : {}),
    });
    return reply.code(204).send();
  });

  app.get<{ Params: { mgId: string } }>('/api/admin/messaging-groups/:mgId/wirings', async (req) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    return await deps.db.listMessagingGroupAgents(req.params.mgId);
  });

  app.post<{ Params: { mgId: string } }>('/api/admin/messaging-groups/:mgId/wirings', async (req, reply) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    const body = z.object({
      groupId: z.string(),
      agentId: z.string(),
      engageMode: z.enum(['pattern', 'mention', 'mention-sticky']).default('pattern'),
      engagePattern: z.string().optional(),
      sessionMode: z.enum(['per-user', 'per-thread', 'shared', 'agent-shared']).default('per-user'),
      ignoredMessagePolicy: z.enum(['drop', 'accumulate']).default('drop'),
    }).parse(req.body);
    if (!(await deps.db.getMessagingGroupById(req.params.mgId))) throw Errors.notFound('messaging-group', req.params.mgId);
    await deps.db.addMessagingGroupAgent({
      messagingGroupId: req.params.mgId,
      groupId: body.groupId,
      agentId: body.agentId,
      engageMode: body.engageMode,
      engagePattern: body.engagePattern ?? null,
      sessionMode: body.sessionMode,
      ignoredMessagePolicy: body.ignoredMessagePolicy,
      createdAt: new Date(),
    });
    return reply.code(201).send({ ok: true });
  });

  app.patch<{ Params: { mgId: string; groupId: string; agentId: string } }>(
    '/api/admin/messaging-groups/:mgId/wirings/:groupId/:agentId',
    async (req, reply) => {
      const ctx = await requireAuth(req);
      requireAdmin(ctx);
      const patch = z.object({
        engageMode: z.enum(['pattern', 'mention', 'mention-sticky']).optional(),
        engagePattern: z.string().nullable().optional(),
        sessionMode: z.enum(['per-user', 'per-thread', 'shared', 'agent-shared']).optional(),
        ignoredMessagePolicy: z.enum(['drop', 'accumulate']).optional(),
      }).parse(req.body);
      await deps.db.updateMessagingGroupAgent(req.params.mgId, req.params.groupId, req.params.agentId, patch);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { mgId: string; groupId: string; agentId: string } }>(
    '/api/admin/messaging-groups/:mgId/wirings/:groupId/:agentId',
    async (req, reply) => {
      const ctx = await requireAuth(req);
      requireAdmin(ctx);
      await deps.db.removeMessagingGroupAgent(req.params.mgId, req.params.groupId, req.params.agentId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { mgId: string } }>('/api/admin/messaging-groups/:mgId/open-dm', async (req) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    const { platform, userHandle } = z.object({
      platform: z.string() as z.ZodType<Platform>,
      userHandle: z.string(),
    }).parse(req.body);
    const adapter = deps.messaging.get(platform);
    if (!adapter) throw Errors.notFound('adapter', platform);
    if (!adapter.openDM) throw Errors.validation(`${platform} adapter does not support openDM`);
    const chatId = await adapter.openDM(userHandle);
    const mg = await deps.db.upsertMessagingGroup({
      id: `mg-${Date.now()}`,
      platform,
      platformChatId: chatId,
      isGroup: false,
      unknownSenderPolicy: 'allow',
      deniedAt: null,
      createdAt: new Date(),
    });
    return { chatId, mgId: mg.id };
  });


  app.get('/api/admin/containers', async (req) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    return deps.containers.list();
  });

  // ── T-6: 強制 rebuild agent image + 重啟容器 ──
  app.post('/api/admin/agents/:agentId/rebuild', async (req, reply) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);
    const { agentId } = req.params as { agentId: string };
    const agent = deps.agents.tryGet(agentId);
    if (!agent) throw Errors.agentNotFound(agentId);

    // 找到該 agent 所屬的 group（可能屬於多個 group，全部 rebuild）
    const allGroups = deps.groups.list();
    const matchedGroups = allGroups.filter((g) => g.agents.includes(agentId));
    if (matchedGroups.length === 0) throw Errors.notFound('group containing agent', agentId);

    const results: Array<{ groupId: string; status: string }> = [];
    for (const group of matchedGroups) {
      try {
        await deps.containers.rebuildImage(agent, group);
        results.push({ groupId: group.id, status: 'ok' });
      } catch (err) {
        results.push({ groupId: group.id, status: err instanceof Error ? err.message : String(err) });
      }
    }
    return reply.status(200).send({ agentId, results });
  });

  /**
   * 對話完整性診斷報表（admin only）
   *
   * 列出每位使用者的所有 session：
   *   - dbMessageCount：sessions 表的 message_count 計數
   *   - actualMessageCount：實際 messages 表內的紀錄數
   *   - userMessages / assistantMessages：分角色拆分
   *   - integrityOk：dbMessageCount === actualMessageCount
   *   - missing：dbMessageCount - actualMessageCount（>0 表示有訊息漏寫）
   *
   * 用以驗證每個 session 的對話歷史是否完整保存到 SQLite。
   */
  app.get('/api/admin/diagnostics/sessions', async (req) => {
    const ctx = await requireAuth(req);
    requireAdmin(ctx);

    const allUsers = await deps.db.listAllUsers();
    const userMap = new Map(allUsers.map((u) => [u.id, u]));
    const allSessions = await deps.db.listAllSessions();

    const sessions = await Promise.all(allSessions.map(async (s) => {
      const actual = await deps.db.countMessages(s.sessionId);
      const byRole = await deps.db.countMessagesByRole(s.sessionId);
      const dbCount = s.messageCount;
      const missing = dbCount - actual;
      const u = userMap.get(s.userId);
      return {
        sessionId: s.sessionId,
        userId: s.userId,
        userDisplayName: u?.displayName ?? s.userId,
        userRole: u?.role ?? 'unknown',
        groupId: s.groupId,
        agentId: s.agentId,
        subAgent: s.subAgent ?? null,
        platform: s.platform,
        title: s.title ?? null,
        status: s.status,
        createdAt: s.createdAt.toISOString(),
        lastMessageAt: s.lastMessageAt.toISOString(),
        dbMessageCount: dbCount,
        actualMessageCount: actual,
        userMessages: byRole.user,
        assistantMessages: byRole.assistant,
        missing,
        integrityOk: missing === 0,
      };
    }));

    // 摘要
    const summary = {
      totalUsers: allUsers.length,
      totalSessions: sessions.length,
      sessionsWithIntegrityIssue: sessions.filter((s) => !s.integrityOk).length,
      totalDbMessages: sessions.reduce((a, s) => a + s.dbMessageCount, 0),
      totalActualMessages: sessions.reduce((a, s) => a + s.actualMessageCount, 0),
      totalMissing: sessions.reduce((a, s) => a + Math.max(0, s.missing), 0),
    };

    // 依使用者分組
    const byUser: Record<
      string,
      {
        userId: string;
        displayName: string;
        role: string;
        sessionCount: number;
        totalDbMessages: number;
        totalActualMessages: number;
        totalMissing: number;
        sessions: typeof sessions;
      }
    > = {};
    for (const s of sessions) {
      const key = s.userId;
      if (!byUser[key]) {
        byUser[key] = {
          userId: s.userId,
          displayName: s.userDisplayName,
          role: s.userRole,
          sessionCount: 0,
          totalDbMessages: 0,
          totalActualMessages: 0,
          totalMissing: 0,
          sessions: [],
        };
      }
      byUser[key].sessionCount += 1;
      byUser[key].totalDbMessages += s.dbMessageCount;
      byUser[key].totalActualMessages += s.actualMessageCount;
      byUser[key].totalMissing += Math.max(0, s.missing);
      byUser[key].sessions.push(s);
    }

    return { summary, users: Object.values(byUser), sessions };
  });
}
