/**
 * session-manager unit tests (SPEC #19)
 *
 * Tests session lifecycle, concurrency lock, messaging session resolution,
 * max sessions per user, and message limit enforcement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type {
  AgentEvent,
  AgentMetadata,
  ChatMessage,
  ContainerInstance,
  GroupConfig,
  SessionRecord,
} from '@zeroclaw/shared';
import type { DbStore } from '../src/db/db-store.js';
import type { ContainerManager, ContainerEntry } from '../src/container/container-manager.js';
import type { AgentProvider } from '../src/agent/agent-provider.js';
import type { GroupsRegistry } from '../src/config/groups-loader.js';
import type { AgentRegistry } from '../src/agent/agent-registry.js';
import { createSessionManager, type SessionManager } from '../src/session/session-manager.js';
import type { Env } from '../src/config/env.js';

// ── Helpers ──────────────────────────────────────────────────────────

const logger = pino({ level: 'silent' });

function makeAgent(id = 'alice'): AgentMetadata {
  return {
    id,
    sdk: 'opencode',
    hasCustomDockerfile: false,
    displayName: id,
    agentDir: `/agents/${id}`,
    subAgents: [],
  } as unknown as AgentMetadata;
}

function makeGroup(id = 'team1', agentIds = ['alice']): GroupConfig {
  return {
    id,
    displayName: 'Team 1',
    enabled: true,
    agents: agentIds,
    defaultAgent: agentIds[0],
    container: { baseImage: 'img:latest', maxSessions: 10 },
    routing: { mode: 'explicit' },
  } as unknown as GroupConfig;
}

function makeSessionRecord(overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    sessionId: randomUUID(),
    userId: 'user-1',
    groupId: 'team1',
    agentId: 'alice',
    subAgent: null,
    containerId: null,
    sdkSessionId: null,
    platform: 'web',
    status: 'pending',
    createdAt: new Date(),
    lastMessageAt: new Date(),
    messageCount: 0,
    ...overrides,
  } as SessionRecord;
}

function makeMockProvider(): AgentProvider {
  return {
    isReady: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockResolvedValue({ sdkSessionId: `sdk-${randomUUID()}` }),
    ensureSession: vi.fn().mockResolvedValue({ sdkSessionId: `sdk-${randomUUID()}` }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    switchAgent: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockImplementation(async function* () {
      yield { type: 'chunk', delta: 'hello' } satisfies AgentEvent;
      yield { type: 'done', messageId: randomUUID() } satisfies AgentEvent;
    }),
    abortTurn: vi.fn().mockResolvedValue(undefined),
    resolveApproval: vi.fn().mockResolvedValue(undefined),
    resolveElicitation: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentProvider;
}

function makeMockContainerEntry(provider?: AgentProvider): ContainerEntry {
  const p = provider ?? makeMockProvider();
  return {
    instance: {
      containerId: `container-${randomUUID()}`,
      groupId: 'team1',
      agentId: 'alice',
      imageTag: 'img:latest',
      host: 'localhost',
      port: 7080,
      protocol: 'http',
      activeSdkSessions: 0,
      maxSessions: 10,
      status: 'running',
      createdAt: new Date(),
      lastActivityAt: new Date(),
    } as ContainerInstance,
    provider: p,
    docker: {} as any,
    sdkSessions: new Set(),
  };
}

/**
 * In-memory DB store for testing — only the methods used by SessionManager
 */
function createInMemoryDb(): DbStore {
  const sessions = new Map<string, SessionRecord>();
  const messages = new Map<string, ChatMessage[]>();

  return {
    createSession: vi.fn(async (s: SessionRecord) => { sessions.set(s.sessionId, { ...s }); }),
    getSession: vi.fn(async (id: string) => {
      const s = sessions.get(id);
      return s ? { ...s } : undefined;
    }),
    listSessionsByUser: vi.fn(async (userId: string) =>
      [...sessions.values()].filter((s) => s.userId === userId),
    ),
    updateSession: vi.fn(async (id: string, patch: Partial<SessionRecord>) => {
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, ...patch });
    }),
    deleteSession: vi.fn(async (id: string) => { sessions.delete(id); }),
    listAllSessions: vi.fn(async () => [...sessions.values()]),
    countActiveSessionsByUser: vi.fn(async (userId: string) =>
      [...sessions.values()].filter(
        (s) => s.userId === userId && (s.status === 'pending' || s.status === 'active'),
      ).length,
    ),
    deleteSessionsOlderThan: vi.fn(async () => 0),
    endIdleSessions: vi.fn(async () => 0),
    findMessagingSession: vi.fn(async () => undefined),
    saveMessage: vi.fn(async (m: ChatMessage) => {
      const list = messages.get(m.sessionId) ?? [];
      list.push(m);
      messages.set(m.sessionId, list);
    }),
    listMessages: vi.fn(async (sessionId: string) => messages.get(sessionId) ?? []),
    countMessages: vi.fn(async (sessionId: string) => (messages.get(sessionId) ?? []).length),
    countMessagesByRole: vi.fn(async () => ({ user: 0, assistant: 0 })),
    upsertUser: vi.fn(async () => {}),
    getUser: vi.fn(async () => undefined),
    findUserByPlatformId: vi.fn(async () => undefined),
    listAllUsers: vi.fn(async () => []),
    createPairing: vi.fn(async () => {}),
    getPairing: vi.fn(async () => undefined),
    consumePairing: vi.fn(async () => {}),
    invalidatePendingPairings: vi.fn(async () => {}),
    listPendingPairings: vi.fn(async () => []),
    upsertMessagingGroup: vi.fn(async (mg) => mg),
    getMessagingGroup: vi.fn(async () => undefined),
    getMessagingGroupById: vi.fn(async () => undefined),
    listMessagingGroups: vi.fn(async () => []),
    deleteMessagingGroup: vi.fn(async () => {}),
    updateMessagingGroup: vi.fn(async () => {}),
    addMessagingGroupAgent: vi.fn(async () => {}),
    updateMessagingGroupAgent: vi.fn(async () => {}),
    removeMessagingGroupAgent: vi.fn(async () => {}),
    listMessagingGroupAgents: vi.fn(async () => []),
    upsertContainer: vi.fn(async () => {}),
    removeContainer: vi.fn(async () => {}),
    listPersistedContainers: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  } as unknown as DbStore;
}

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    MAX_SESSIONS_PER_USER: 20,
    SESSION_IDLE_TIMEOUT_SEC: 1800,
    SESSION_MAX_MESSAGES: 200,
    SESSION_RETENTION_DAYS: 30,
    CONTAINER_IDLE_TIMEOUT_SEC: 1800,
    ...overrides,
  } as Env;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('SessionManager', () => {
  let db: DbStore;
  let containerEntry: ContainerEntry;
  let containers: ContainerManager;
  let sm: SessionManager;
  const agent = makeAgent();
  const group = makeGroup();

  beforeEach(() => {
    db = createInMemoryDb();
    containerEntry = makeMockContainerEntry();
    containers = {
      acquire: vi.fn().mockResolvedValue(containerEntry),
      findEntry: vi.fn().mockReturnValue(containerEntry),
      list: vi.fn().mockReturnValue([]),
      stop: vi.fn().mockResolvedValue(undefined),
      attachSession: vi.fn(),
      detachSession: vi.fn(),
      startGc: vi.fn(),
      restart: vi.fn().mockResolvedValue(containerEntry),
      invalidate: vi.fn(),
      adoptFromDb: vi.fn().mockResolvedValue(undefined),
      onUnhealthy: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContainerManager;

    const groupsReg: GroupsRegistry = {
      get: vi.fn().mockReturnValue(group),
      list: vi.fn().mockReturnValue([group]),
      reload: vi.fn().mockResolvedValue(undefined),
    } as unknown as GroupsRegistry;

    const agentsReg: AgentRegistry = {
      get: vi.fn().mockReturnValue(agent),
      tryGet: vi.fn().mockReturnValue(agent),
      list: vi.fn().mockReturnValue([agent]),
    } as unknown as AgentRegistry;

    sm = createSessionManager({
      logger,
      groups: groupsReg,
      agents: agentsReg,
      containers,
      db,
      env: makeEnv(),
    });
  });

  afterEach(() => {
    sm.stopLifecycle();
  });

  // ── createOrGet ──

  it('creates a new session with pending status', async () => {
    const s = await sm.createOrGet({
      userId: 'user-1',
      groupId: 'team1',
      platform: 'web',
    });
    expect(s.sessionId).toBeTruthy();
    expect(s.status).toBe('pending');
    expect(s.agentId).toBe('alice');
    expect(db.createSession).toHaveBeenCalledTimes(1);
  });

  // ── T-3: max sessions per user ──

  it('rejects session creation when max sessions reached', async () => {
    // Override env to have max=2
    sm.stopLifecycle();
    sm = createSessionManager({
      logger,
      groups: { get: vi.fn().mockReturnValue(group), list: vi.fn().mockReturnValue([group]), reload: vi.fn() } as unknown as GroupsRegistry,
      agents: { get: vi.fn().mockReturnValue(agent), tryGet: vi.fn().mockReturnValue(agent), list: vi.fn().mockReturnValue([agent]) } as unknown as AgentRegistry,
      containers,
      db,
      env: makeEnv({ MAX_SESSIONS_PER_USER: 2 }),
    });

    // Create 2 sessions
    await sm.createOrGet({ userId: 'user-1', groupId: 'team1', platform: 'web' });
    await sm.createOrGet({ userId: 'user-1', groupId: 'team1', platform: 'web' });

    // 3rd should fail
    await expect(
      sm.createOrGet({ userId: 'user-1', groupId: 'team1', platform: 'web' }),
    ).rejects.toThrow(/session 上限/);
  });

  it('allows session creation when max is 0 (unlimited)', async () => {
    sm.stopLifecycle();
    sm = createSessionManager({
      logger,
      groups: { get: vi.fn().mockReturnValue(group), list: vi.fn().mockReturnValue([group]), reload: vi.fn() } as unknown as GroupsRegistry,
      agents: { get: vi.fn().mockReturnValue(agent), tryGet: vi.fn().mockReturnValue(agent), list: vi.fn().mockReturnValue([agent]) } as unknown as AgentRegistry,
      containers,
      db,
      env: makeEnv({ MAX_SESSIONS_PER_USER: 0 }),
    });

    // Should be able to create many
    for (let i = 0; i < 25; i++) {
      await sm.createOrGet({ userId: 'user-1', groupId: 'team1', platform: 'web' });
    }
    expect(db.createSession).toHaveBeenCalledTimes(25);
  });

  // ── T-3: message limit ──

  it('rejects messages when session reaches message limit', async () => {
    sm.stopLifecycle();
    sm = createSessionManager({
      logger,
      groups: { get: vi.fn().mockReturnValue(group), list: vi.fn().mockReturnValue([group]), reload: vi.fn() } as unknown as GroupsRegistry,
      agents: { get: vi.fn().mockReturnValue(agent), tryGet: vi.fn().mockReturnValue(agent), list: vi.fn().mockReturnValue([agent]) } as unknown as AgentRegistry,
      containers,
      db,
      env: makeEnv({ SESSION_MAX_MESSAGES: 10 }),
    });

    const session = await sm.createOrGet({ userId: 'user-1', groupId: 'team1', platform: 'web' });

    // Simulate session with 10 messages already
    await db.updateSession(session.sessionId, { messageCount: 10 });

    const iter = sm.handleMessage(session.sessionId, {
      text: 'hello',
      receivedAt: new Date(),
    });

    // Should throw message limit error
    await expect(async () => {
      for await (const _ of iter) { /* consume */ }
    }).rejects.toThrow(/訊息上限/);
  });

  // ── T-3: ended session auto-reopen ──

  it('reopens ended session instead of rejecting', async () => {
    const session = await sm.createOrGet({ userId: 'user-1', groupId: 'team1', platform: 'web' });
    await db.updateSession(session.sessionId, { status: 'ended' });

    // handleMessage should reopen the session, not throw
    const iter = sm.handleMessage(session.sessionId, {
      text: 'hello',
      receivedAt: new Date(),
    });

    // Consume — should NOT throw (container will be lazily started)
    for await (const _ of iter) { /* consume */ }

    const updated = await sm.get(session.sessionId);
    expect(updated.status).not.toBe('ended');
  });

  // ── resolveMessagingSession ──

  it('creates new session when no existing messaging session', async () => {
    const session = await sm.resolveMessagingSession({
      userId: 'user-1',
      groupId: 'team1',
      agentId: 'alice',
      messagingGroupId: 'mg-1',
      threadId: null,
      platform: 'telegram',
      platformChatId: '12345',
      platformUserId: 'tg-user-1',
      sessionMode: 'per-user',
    });

    expect(session.sessionId).toBeTruthy();
    expect(session.status).toBe('pending');
    expect(session.platform).toBe('telegram');
    expect(db.findMessagingSession).toHaveBeenCalledTimes(1);
    expect(db.createSession).toHaveBeenCalledTimes(1);
  });

  it('returns existing session when found by messaging lookup', async () => {
    const existing = makeSessionRecord({
      platform: 'telegram',
      platformUserId: 'tg-user-1',
    });
    (db.findMessagingSession as any).mockResolvedValueOnce(existing);

    const session = await sm.resolveMessagingSession({
      userId: 'user-1',
      groupId: 'team1',
      agentId: 'alice',
      messagingGroupId: 'mg-1',
      threadId: null,
      platform: 'telegram',
      platformChatId: '12345',
      platformUserId: 'tg-user-1',
      sessionMode: 'per-user',
    });

    expect(session.sessionId).toBe(existing.sessionId);
    expect(db.createSession).not.toHaveBeenCalled();
  });

  // ── handleMessage basics ──

  it('lazily starts container on first message', async () => {
    const session = await sm.createOrGet({ userId: 'user-1', groupId: 'team1', platform: 'web' });

    const events: AgentEvent[] = [];
    for await (const e of sm.handleMessage(session.sessionId, {
      text: 'hi',
      receivedAt: new Date(),
    })) {
      events.push(e);
    }

    expect(containers.acquire).toHaveBeenCalled();
    expect(containerEntry.provider.createSession).toHaveBeenCalled();
    expect(containers.attachSession).toHaveBeenCalled();
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  // ── T-2: Per-session concurrency lock ──

  it('serializes concurrent messages to the same session', async () => {
    const session = await sm.createOrGet({ userId: 'user-1', groupId: 'team1', platform: 'web' });

    // Track call order
    const callOrder: string[] = [];
    const provider = containerEntry.provider;
    (provider.sendMessage as any).mockImplementation(async function* () {
      callOrder.push('start');
      await new Promise((r) => setTimeout(r, 50));
      callOrder.push('end');
      yield { type: 'chunk', delta: 'ok' };
      yield { type: 'done', messageId: randomUUID() };
    });

    // Send two messages simultaneously
    const consume = async (iter: AsyncIterable<AgentEvent>) => {
      for await (const _ of iter) { /* drain */ }
    };
    const p1 = consume(sm.handleMessage(session.sessionId, { text: 'msg1', receivedAt: new Date() }));
    const p2 = consume(sm.handleMessage(session.sessionId, { text: 'msg2', receivedAt: new Date() }));

    await Promise.all([p1, p2]);

    // With the lock, start-end pairs should not interleave
    // Expected: [start, end, start, end] not [start, start, end, end]
    expect(callOrder[0]).toBe('start');
    expect(callOrder[1]).toBe('end');
    expect(callOrder[2]).toBe('start');
    expect(callOrder[3]).toBe('end');
  });

  // ── get / list / delete ──

  it('get returns session record', async () => {
    const created = await sm.createOrGet({ userId: 'user-1', groupId: 'team1', platform: 'web' });
    const fetched = await sm.get(created.sessionId);
    expect(fetched.sessionId).toBe(created.sessionId);
  });

  it('get throws for nonexistent session', async () => {
    await expect(sm.get('nonexistent')).rejects.toThrow();
  });

  it('delete removes session and cleans up container', async () => {
    const session = await sm.createOrGet({ userId: 'user-1', groupId: 'team1', platform: 'web' });
    await sm.delete(session.sessionId);
    expect(db.deleteSession).toHaveBeenCalledWith(session.sessionId);
  });

  it('list returns sessions for a user', async () => {
    await sm.createOrGet({ userId: 'user-1', groupId: 'team1', platform: 'web' });
    await sm.createOrGet({ userId: 'user-1', groupId: 'team1', platform: 'web' });
    const result = await sm.list('user-1');
    expect(result.length).toBe(2);
  });
});
