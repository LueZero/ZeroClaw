/**
 * SessionManager -- coordinates DB + ContainerManager + AgentProvider
 *
 * Responsibilities:
 *  - Create/get sessions (reuse per userId+groupId+agentId)
 *  - Maintain sessionId <-> containerId <-> sdkSessionId mapping
 *  - Persist messages / AgentEvents to DB
 *  - Resolve routing: which agent handles a message
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { Errors } from '@zeroclaw/shared';
import type {
  AgentEvent,
  AgentMetadata,
  ChatMessage,
  GroupConfig,
  IncomingMessage,
  Platform,
  SessionMode,
  SessionRecord,
} from '@zeroclaw/shared';
import type { FindMessagingSessionParams } from '../db/db-store.js';
import type { GroupsRegistry } from '../config/groups-loader.js';
import type { AgentRegistry } from '../agent/agent-registry.js';
import type { ContainerManager } from '../container/container-manager.js';
import type { DbStore } from '../db/db-store.js';
import type { AutoRouter } from './auto-router.js';
import type { AgentProvider } from '../agent/agent-provider.js';
import type { Env } from '../config/env.js';

export interface SessionManagerDeps {
  logger: Logger;
  groups: GroupsRegistry;
  agents: AgentRegistry;
  containers: ContainerManager;
  db: DbStore;
  autoRouter?: AutoRouter;
  env: Env;
}

export interface CreateSessionInput {
  userId: string;
  groupId: string;
  agentId?: string;
  platform: Platform;
  platformUserId?: string;
  title?: string;
}

export interface ResolvedAgent {
  group: GroupConfig;
  agent: AgentMetadata;
}

export interface ResolveMessagingSessionInput {
  userId: string;
  groupId: string;
  agentId: string;
  messagingGroupId: string;
  threadId: string | null;
  platform: Platform;
  platformChatId: string;
  platformUserId: string;
  sessionMode: SessionMode;
}

export interface SessionManager {
  createOrGet(input: CreateSessionInput): Promise<SessionRecord>;
  resolveMessagingSession(input: ResolveMessagingSessionInput): Promise<SessionRecord>;
  get(sessionId: string): Promise<SessionRecord>;
  list(userId: string, groupId?: string): Promise<SessionRecord[]>;
  delete(sessionId: string): Promise<void>;

  switchAgent(
    sessionId: string,
    nextAgentId: string,
    subAgent?: string,
  ): Promise<SessionRecord>;

  handleMessage(
    sessionId: string,
    message: IncomingMessage,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent>;

  abort(sessionId: string): Promise<void>;

  resolveAgent(group: GroupConfig, message: IncomingMessage): Promise<ResolvedAgent>;

  resolveApproval(sessionId: string, requestId: string, approved: boolean): Promise<void>;
  resolveElicitation(sessionId: string, requestId: string, answer: string): Promise<void>;

  /** Start lifecycle timers (idle timeout, retention cleanup). Call once at startup. */
  startLifecycle(): void;
  /** Stop lifecycle timers. */
  stopLifecycle(): void;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { logger, groups, agents, containers, db, autoRouter, env } = deps;

  const maxSessionsPerUser = env.MAX_SESSIONS_PER_USER;
  const idleTimeoutSec = env.SESSION_IDLE_TIMEOUT_SEC;
  const maxMessages = env.SESSION_MAX_MESSAGES;
  const retentionDays = env.SESSION_RETENTION_DAYS;

  // Per-session message queue: ensures only one message is processed at a time per session,
  // preventing concurrent SDK calls that cause out-of-order events (T-2).
  const sessionLocks = new Map<string, Promise<void>>();
  let lifecycleTimer: NodeJS.Timeout | null = null;

  async function resolveAgent(group: GroupConfig, message: IncomingMessage): Promise<ResolvedAgent> {
    const candidates = group.agents
      .map((id) => agents.tryGet(id))
      .filter((a): a is AgentMetadata => !!a);
    if (candidates.length === 0) {
      throw Errors.agentNotFound(`group ${group.id} has no valid agents`);
    }

    if (message.mentionedAgent) {
      const found = candidates.find((a) => a.id === message.mentionedAgent);
      if (found) return { group, agent: found };
    }

    switch (group.routing.mode) {
      case 'explicit': {
        const target = group.defaultAgent ?? group.routing.fallback ?? candidates[0]!.id;
        const agent = candidates.find((a) => a.id === target) ?? candidates[0]!;
        return { group, agent };
      }
      case 'round-robin': {
        const idx = Number(message.receivedAt.getTime()) % candidates.length;
        return { group, agent: candidates[idx]! };
      }
      case 'auto': {
        if (autoRouter) {
          try {
            const classifiedId = await autoRouter.classify(
              message,
              candidates,
              group.routing.autoClassifierModel,
            );
            const classified = candidates.find((a) => a.id === classifiedId);
            if (classified) {
              logger.debug({ group: group.id, classified: classifiedId }, 'Auto-routed message');
              return { group, agent: classified };
            }
          } catch (err) {
            logger.warn({ err, group: group.id }, 'Auto-classify failed, using fallback');
          }
        }
        const target = group.defaultAgent ?? group.routing.fallback ?? candidates[0]!.id;
        const agent = candidates.find((a) => a.id === target) ?? candidates[0]!;
        return { group, agent };
      }
    }
  }

  async function createOrGet(input: CreateSessionInput): Promise<SessionRecord> {
    const group = groups.get(input.groupId);
    if (!group) throw Errors.groupNotFound(input.groupId);

    const agentId = input.agentId ?? group.defaultAgent ?? group.agents[0]!;
    const agent = agents.get(agentId);

    if (!group.agents.includes(agentId)) {
      throw Errors.agentNotFound(`agent ${agentId} is not in group ${group.id}`);
    }

    // T-3: max sessions per user
    if (maxSessionsPerUser > 0) {
      const count = await db.countActiveSessionsByUser(input.userId);
      if (count >= maxSessionsPerUser) {
        throw Errors.validation(`已達每用戶 session 上限 (${maxSessionsPerUser})。請先結束現有 session。`);
      }
    }

    const sessionId = randomUUID();
    const now = new Date();
    const record: SessionRecord = {
      sessionId,
      userId: input.userId,
      groupId: group.id,
      agentId: agent.id,
      subAgent: agent.primaryAgent,
      containerId: null,
      sdkSessionId: null,
      platform: input.platform,
      platformUserId: input.platformUserId,
      title: input.title,
      status: 'pending',
      createdAt: now,
      lastMessageAt: now,
      messageCount: 0,
    };
    await db.createSession(record);
    logger.info(
      { sessionId, agent: agent.id, group: group.id, sdk: agent.sdk },
      'Session created (pending -- container deferred)',
    );
    return record;
  }

  /** Lazy container start: acquire container + create SDK session */
  /** T-1: replay history messages into a newly created SDK session */
  async function replayHistory(provider: AgentProvider, sdkSessionId: string, sessionId: string): Promise<void> {
    if (!provider.injectHistory) return;
    try {
      const messages = await db.listMessages(sessionId);
      if (messages.length === 0) return;
      // Limit to most recent 50 messages (configurable via group in future)
      const recent = messages.slice(-50);
      await provider.injectHistory(sdkSessionId, recent);
      logger.info({ sessionId, messageCount: recent.length }, 'History replayed into new SDK session');
    } catch (err) {
      logger.warn({ err, sessionId }, 'History replay failed (non-fatal)');
    }
  }

  async function ensureContainer(session: SessionRecord) {
    const group = groups.get(session.groupId);
    if (!group) throw Errors.groupNotFound(session.groupId);
    const agent = agents.get(session.agentId);

    const entry = await containers.acquire(group, agent);
    const handle = await entry.provider.createSession({
      sessionId: session.sessionId,
      userId: session.userId,
      agentId: agent.id,
      subAgent: session.subAgent ?? agent.primaryAgent,
    });
    containers.attachSession(entry.instance.containerId, handle.sdkSessionId);

    await db.updateSession(session.sessionId, {
      containerId: entry.instance.containerId,
      sdkSessionId: handle.sdkSessionId,
      status: 'active',
    });

    // T-1: replay history if session has prior messages (container restart / migration)
    await replayHistory(entry.provider, handle.sdkSessionId, session.sessionId);

    logger.info(
      { sessionId: session.sessionId, containerId: entry.instance.containerId },
      'Container launched on first message',
    );
    return entry;
  }

  async function get(sessionId: string): Promise<SessionRecord> {
    const s = await db.getSession(sessionId);
    if (!s) throw Errors.sessionNotFound(sessionId);
    return s;
  }

  async function list(userId: string, groupId?: string): Promise<SessionRecord[]> {
    return db.listSessionsByUser(userId, groupId);
  }

  async function deleteFn(sessionId: string): Promise<void> {
    const session = await db.getSession(sessionId);
    if (!session) return;
    if (session.containerId && session.sdkSessionId) {
      const entry = findContainerEntry(session.containerId);
      if (entry) {
        try {
          await entry.provider.closeSession(session.sdkSessionId);
        } catch (e) {
          logger.warn({ err: e, sessionId }, 'closeSession failed');
        }
        containers.detachSession(session.containerId, session.sdkSessionId);
      }
    }
    await db.deleteSession(sessionId);
  }

  async function switchAgent(
    sessionId: string,
    nextAgentId: string,
    subAgent?: string,
  ): Promise<SessionRecord> {
    const session = await get(sessionId);
    const group = groups.get(session.groupId);
    if (!group) throw Errors.groupNotFound(session.groupId);

    if (nextAgentId === session.agentId) {
      if (subAgent && subAgent !== session.subAgent) {
        if (session.containerId && session.sdkSessionId) {
          const entry = findContainerEntry(session.containerId);
          await entry?.provider.switchAgent(session.sdkSessionId, subAgent);
        }
        await db.updateSession(sessionId, { subAgent });
      }
      return get(sessionId);
    }

    if (!group.agents.includes(nextAgentId)) {
      throw Errors.agentNotFound(`agent ${nextAgentId} not in group ${group.id}`);
    }
    const newAgent = agents.get(nextAgentId);
    const newEntry = await containers.acquire(group, newAgent);
    const handle = await newEntry.provider.createSession({
      sessionId,
      userId: session.userId,
      agentId: newAgent.id,
      subAgent: subAgent ?? newAgent.primaryAgent,
    });
    containers.attachSession(newEntry.instance.containerId, handle.sdkSessionId);

    if (session.containerId && session.sdkSessionId) {
      const oldEntry = findContainerEntry(session.containerId);
      if (oldEntry) {
        try {
          await oldEntry.provider.closeSession(session.sdkSessionId);
        } catch {
          // ignore
        }
        containers.detachSession(session.containerId, session.sdkSessionId);
      }
    }

    await db.updateSession(sessionId, {
      agentId: newAgent.id,
      subAgent: subAgent ?? newAgent.primaryAgent,
      containerId: newEntry.instance.containerId,
      sdkSessionId: handle.sdkSessionId,
    });
    return get(sessionId);
  }

  async function* handleMessage(
    sessionId: string,
    message: IncomingMessage,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    // Per-session concurrency lock: queue behind any in-flight message (T-2)
    const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
    let unlock!: () => void;
    const slot = new Promise<void>((r) => { unlock = r; });
    sessionLocks.set(sessionId, slot);

    try {
      await prev;
      yield* handleMessageBody(sessionId, message, signal);
    } finally {
      unlock();
      if (sessionLocks.get(sessionId) === slot) sessionLocks.delete(sessionId);
    }
  }

  async function* handleMessageBody(
    sessionId: string,
    message: IncomingMessage,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    let session = await get(sessionId);

    // T-3: session in error state — cannot recover
    if (session.status === 'error') {
      throw Errors.validation(`Session ${sessionId} 已結束 (${session.status})。`);
    }

    // T-3: ended session — auto-reopen (idle timeout / manual end → user wants to continue)
    if (session.status === 'ended') {
      logger.info({ sessionId }, 'Reopening ended session');
      await db.updateSession(sessionId, { status: 'active' });
      session = await get(sessionId);
    }

    // T-3: message limit check
    if (maxMessages > 0 && session.messageCount >= maxMessages) {
      await db.updateSession(sessionId, { status: 'ended' });
      logger.info({ sessionId, messageCount: session.messageCount, limit: maxMessages }, 'Session ended: message limit reached');
      throw Errors.validation(`Session 已達訊息上限 (${maxMessages})。請建立新 session。`);
    }

    // Touch lastMessageAt immediately so the lifecycle timer cannot kill this session
    // while we are waiting for the container to launch (ensureContainer can take up to 120s).
    await db.updateSession(sessionId, { lastMessageAt: new Date() });
    session = await get(sessionId);

    if (session.status === 'pending' || !session.containerId || !session.sdkSessionId) {
      await ensureContainer(session);
      session = await get(sessionId);
    }

    let entry = findContainerEntry(session.containerId!);
    let probedDead = false;
    if (entry && entry.instance.status !== 'unhealthy') {
      try {
        const ok = await entry.provider.isReady();
        if (!ok) probedDead = true;
      } catch {
        probedDead = true;
      }
      if (probedDead) {
        logger.warn(
          { sessionId, containerId: entry.instance.containerId },
          'Container probe failed before send -- invalidating',
        );
        containers.invalidate(entry.instance.containerId);
      }
    }
    const isUnhealthy = entry && entry.instance.status === 'unhealthy';
    if (!entry || isUnhealthy || probedDead) {
      logger.warn(
        {
          sessionId,
          oldContainer: session.containerId,
          reason: probedDead ? 'probe-failed' : isUnhealthy ? 'unhealthy' : 'missing',
        },
        'Container unavailable -- migrating session to new container',
      );
      const group = groups.get(session.groupId);
      if (!group) throw Errors.groupNotFound(session.groupId);
      const agent = agents.get(session.agentId);

      const newEntry = await containers.acquire(group, agent);
      const handle = await newEntry.provider.createSession({
        sessionId,
        userId: session.userId,
        agentId: agent.id,
        subAgent: session.subAgent ?? agent.primaryAgent,
      });
      containers.attachSession(newEntry.instance.containerId, handle.sdkSessionId);

      await db.updateSession(sessionId, {
        containerId: newEntry.instance.containerId,
        sdkSessionId: handle.sdkSessionId,
      });

      if (entry && session.containerId && session.sdkSessionId) {
        containers.detachSession(session.containerId, session.sdkSessionId);
      }

      // T-1: replay history into migrated session
      await replayHistory(newEntry.provider, handle.sdkSessionId, sessionId);

      entry = newEntry;
      const updatedSession = await get(sessionId);
      logger.info(
        { sessionId, newContainer: updatedSession.containerId },
        'Session migrated successfully',
      );
    }

    const userMsg: ChatMessage = {
      id: randomUUID(),
      sessionId,
      role: 'user',
      content: message.text,
      createdAt: message.receivedAt,
    };
    await db.saveMessage(userMsg);

    // T-10: increment messageCount immediately for user message (+1)
    await db.updateSession(sessionId, {
      lastMessageAt: message.receivedAt,
      messageCount: session.messageCount + 1,
    });

    let assistantContent = '';
    const assistantMessageId = randomUUID();

    async function* sendWithRetry(): AsyncIterable<AgentEvent> {
      const sess = await get(sessionId);
      for await (const event of entry!.provider.sendMessage(sess.sdkSessionId!, {
        text: message.text,
        attachments: message.attachments,
        signal,
      })) {
        if (event.type === 'chunk') {
          assistantContent += event.delta;
        }
        if (event.type === 'done') {
          const latestSession = await get(sessionId);
          const assistantMsg: ChatMessage = {
            id: assistantMessageId,
            sessionId,
            role: 'assistant',
            agentId: latestSession.agentId,
            content: assistantContent,
            usage: event.usage,
            createdAt: new Date(),
          };
          await db.saveMessage(assistantMsg);
          // T-10: +1 for assistant message only (user already counted above)
          await db.updateSession(sessionId, {
            lastMessageAt: new Date(),
            messageCount: latestSession.messageCount + 1,
          });
        }
        yield event;
      }
    }

    try {
      yield* sendWithRetry();
    } catch (e) {
      // T-10: save partial assistant content on error (if any accumulated)
      if (assistantContent.length > 0) {
        try {
          const latestSession = await get(sessionId);
          const partialMsg: ChatMessage = {
            id: assistantMessageId,
            sessionId,
            role: 'assistant',
            agentId: latestSession.agentId,
            content: assistantContent,
            createdAt: new Date(),
          };
          await db.saveMessage(partialMsg);
          await db.updateSession(sessionId, {
            lastMessageAt: new Date(),
            messageCount: latestSession.messageCount + 1,
          });
        } catch (saveErr) {
          logger.warn({ err: saveErr, sessionId }, 'Failed to save partial assistant message');
        }
      }

      const msg = e instanceof Error ? e.message : String(e);
      if (/404|not.found|session.*not.*exist/i.test(msg)) {
        const staleSession = await get(sessionId);
        logger.warn({ sessionId, oldSdkSessionId: staleSession.sdkSessionId }, 'SDK session stale -- recreating');
        const agent = agents.get(staleSession.agentId);
        const handle = await entry!.provider.createSession({
          sessionId,
          userId: staleSession.userId,
          agentId: agent.id,
          subAgent: staleSession.subAgent ?? agent.primaryAgent,
        });
        await db.updateSession(sessionId, { sdkSessionId: handle.sdkSessionId });
        // T-1: replay history into recreated SDK session
        await replayHistory(entry!.provider, handle.sdkSessionId, sessionId);
        assistantContent = '';
        yield* sendWithRetry();
      } else {
        logger.error({ err: e, sessionId }, 'handleMessage error');
        throw e;
      }
    }
  }

  async function abort(sessionId: string): Promise<void> {
    const session = await get(sessionId);
    if (!session.containerId || !session.sdkSessionId) return;
    const entry = findContainerEntry(session.containerId);
    if (!entry) return;
    await entry.provider.abortTurn(session.sdkSessionId);
  }

  async function resolveApproval(
    sessionId: string,
    requestId: string,
    approved: boolean,
  ): Promise<void> {
    const s = await get(sessionId);
    if (!s.containerId) {
      logger.warn({ sessionId }, 'Cannot resolve approval -- no container (pending session)');
      return;
    }
    const e = findContainerEntry(s.containerId);
    if (!e) {
      logger.warn({ sessionId }, 'Cannot resolve approval -- container unavailable');
      return;
    }
    await e.provider.resolveApproval(s.sdkSessionId!, requestId, approved);
  }

  async function resolveElicitation(
    sessionId: string,
    requestId: string,
    answer: string,
  ): Promise<void> {
    const s = await get(sessionId);
    if (!s.containerId) {
      logger.warn({ sessionId }, 'Cannot resolve elicitation -- no container (pending session)');
      return;
    }
    const e = findContainerEntry(s.containerId);
    if (!e) {
      logger.warn({ sessionId }, 'Cannot resolve elicitation -- container unavailable');
      return;
    }
    await e.provider.resolveElicitation(s.sdkSessionId!, requestId, answer);
  }

  function findContainerEntry(containerId: string | null) {
    if (!containerId) return undefined;
    return containers.findEntry(containerId);
  }

  async function resolveMessagingSession(input: ResolveMessagingSessionInput): Promise<SessionRecord> {
    const existing = await db.findMessagingSession({
      groupId: input.groupId,
      agentId: input.agentId,
      messagingGroupId: input.messagingGroupId,
      threadId: input.threadId,
      platformUserId: input.platformUserId,
      sessionMode: input.sessionMode,
    });
    if (existing) return existing;

    const group = groups.get(input.groupId);
    if (!group) throw Errors.groupNotFound(input.groupId);
    const agent = agents.get(input.agentId);

    const sessionId = randomUUID();
    const now = new Date();
    const record: SessionRecord = {
      sessionId,
      userId: input.userId,
      groupId: input.groupId,
      agentId: input.agentId,
      subAgent: agent.primaryAgent,
      containerId: null,
      sdkSessionId: null,
      platform: input.platform,
      platformUserId: input.platformUserId,
      platformChatId: input.platformChatId,
      threadId: input.threadId,
      messagingGroupId: input.messagingGroupId,
      title: undefined,
      status: 'pending',
      createdAt: now,
      lastMessageAt: now,
      messageCount: 0,
    };
    await db.createSession(record);
    logger.info({ sessionId, agentId: input.agentId, groupId: input.groupId, sessionMode: input.sessionMode }, 'Messaging session created');
    return record;
  }

  // ── T-3: Session lifecycle timers ──────────────────────────────────

  async function runLifecycleTick(): Promise<void> {
    try {
      // 1. End idle *active* sessions (SESSION_IDLE_TIMEOUT_SEC)
      //    Only targets 'active' — pending sessions are handled separately below
      //    to avoid killing sessions whose container is still launching.
      if (idleTimeoutSec > 0) {
        const idleSince = new Date(Date.now() - idleTimeoutSec * 1000);
        const ended = await db.endIdleSessions(idleSince);
        if (ended > 0) {
          logger.info({ ended, idleTimeoutSec }, 'Lifecycle: ended idle sessions');
        }
      }

      // 1b. End stale *pending* sessions that never received a message
      //     (container launch failed / abandoned before first message).
      //     Use a shorter fixed window: max(idleTimeoutSec, 600) seconds.
      {
        const pendingStaleSec = Math.max(idleTimeoutSec, 600);
        const pendingSince = new Date(Date.now() - pendingStaleSec * 1000);
        const endedPending = await db.endStalePendingSessions(pendingSince);
        if (endedPending > 0) {
          logger.info({ endedPending, pendingStaleSec }, 'Lifecycle: ended stale pending sessions');
        }
      }

      // 2. Clean up old ended/error sessions
      if (retentionDays > 0) {
        const before = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        const deleted = await db.deleteSessionsOlderThan(before);
        if (deleted > 0) {
          logger.info({ deleted, retentionDays }, 'Lifecycle: cleaned up old sessions');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Lifecycle tick error');
    }
  }

  function startLifecycle(): void {
    if (lifecycleTimer) return;
    // Run once on startup, then every 60 seconds
    void runLifecycleTick();
    lifecycleTimer = setInterval(() => void runLifecycleTick(), 60_000);
  }

  function stopLifecycle(): void {
    if (lifecycleTimer) {
      clearInterval(lifecycleTimer);
      lifecycleTimer = null;
    }
  }

  return {
    createOrGet,
    resolveMessagingSession,
    get,
    list,
    delete: deleteFn,
    switchAgent,
    handleMessage,
    abort,
    resolveAgent,
    resolveApproval,
    resolveElicitation,
    startLifecycle,
    stopLifecycle,
  };
}