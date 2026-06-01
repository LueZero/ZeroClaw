/**
 * SQLite store (better-sqlite3) -- async interface wrapper
 *
 * Tables: users / sessions / messages / pairings /
 *         messaging_groups / messaging_group_agents / containers
 *
 * v0.3 changes:
 *   - chat_bindings removed (DROP on startup)
 *   - messaging_groups + messaging_group_agents added
 *   - sessions: added platform_chat_id / thread_id / messaging_group_id
 *   - containers table for ContainerPool persistence
 *   - findMessagingSession + messaging group CRUD
 *   - DbStore interface is fully async; SQLite wraps sync calls in Promise.resolve
 */

import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type {
  SessionRecord,
  ChatMessage,
  User,
  Platform,
  Role,
  SessionMode,
  EngageMode,
  IgnoredMessagePolicy,
  MessagingGroup,
  MessagingGroupAgent,
  MessagingGroupWithWirings,
  ContainerInstance,
  GroupOverride,
} from '@zeroclaw/shared';

export interface PairingCode {
  code: string;
  groupId: string;
  platform: Platform;
  agentId?: string;
  engageMode?: EngageMode;
  engagePattern?: string;
  sessionMode?: SessionMode;
  status: 'pending' | 'consumed' | 'invalidated';
  createdAt: Date;
  consumedChatId?: string;
  consumedAt?: Date;
}

export interface FindMessagingSessionParams {
  groupId: string;
  agentId: string;
  messagingGroupId: string;
  threadId: string | null;
  platformUserId: string;
  sessionMode: SessionMode;
}

/** Fully async interface -- shared by SQLite and PostgreSQL implementations */
export interface DbStore {
  // sessions
  createSession(s: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  listSessionsByUser(userId: string, groupId?: string): Promise<SessionRecord[]>;
  updateSession(id: string, patch: Partial<SessionRecord>): Promise<void>;
  deleteSession(id: string): Promise<void>;
  listAllSessions(): Promise<SessionRecord[]>;

  /** Count active (pending/active) sessions for a user */
  countActiveSessionsByUser(userId: string): Promise<number>;

  /** Delete sessions older than given date, return count */
  deleteSessionsOlderThan(before: Date): Promise<number>;

  /** End sessions that have been idle (lastMessageAt) since given date — only 'active' status */
  endIdleSessions(idleSince: Date): Promise<number>;

  /** End pending sessions whose lastMessageAt is older than staleSince (container launch abandoned) */
  endStalePendingSessions(staleSince: Date): Promise<number>;

  /** Find messaging session by sessionMode lookup key */
  findMessagingSession(params: FindMessagingSessionParams): Promise<SessionRecord | undefined>;

  // messages
  saveMessage(m: ChatMessage): Promise<void>;
  listMessages(sessionId: string, limit?: number): Promise<ChatMessage[]>;
  countMessages(sessionId: string): Promise<number>;
  countMessagesByRole(sessionId: string): Promise<{ user: number; assistant: number }>;

  // users
  upsertUser(u: User): Promise<void>;
  getUser(id: string): Promise<User | undefined>;
  findUserByPlatformId(platform: Platform, externalId: string): Promise<User | undefined>;
  listAllUsers(): Promise<User[]>;

  // pairings
  createPairing(p: PairingCode): Promise<void>;
  getPairing(code: string): Promise<PairingCode | undefined>;
  consumePairing(code: string, chatId: string): Promise<void>;
  invalidatePendingPairings(groupId: string, platform: Platform): Promise<void>;
  listPendingPairings(): Promise<PairingCode[]>;

  // messaging groups
  upsertMessagingGroup(mg: MessagingGroup): Promise<MessagingGroup>;
  getMessagingGroup(platform: Platform, platformChatId: string): Promise<MessagingGroup | undefined>;
  getMessagingGroupById(id: string): Promise<MessagingGroup | undefined>;
  listMessagingGroups(): Promise<MessagingGroupWithWirings[]>;
  deleteMessagingGroup(id: string): Promise<void>;
  updateMessagingGroup(id: string, patch: { unknownSenderPolicy?: string; deniedAt?: string | null }): Promise<void>;

  // messaging group agents (wirings)
  addMessagingGroupAgent(mga: MessagingGroupAgent): Promise<void>;
  updateMessagingGroupAgent(
    mgId: string,
    groupId: string,
    agentId: string,
    patch: Partial<Pick<MessagingGroupAgent, 'engageMode' | 'engagePattern' | 'sessionMode' | 'ignoredMessagePolicy'>>,
  ): Promise<void>;
  removeMessagingGroupAgent(mgId: string, groupId: string, agentId: string): Promise<void>;
  listMessagingGroupAgents(mgId: string): Promise<MessagingGroupAgent[]>;

  // containers (ContainerPool persistence)
  upsertContainer(c: ContainerInstance): Promise<void>;
  removeContainer(containerId: string): Promise<void>;
  listPersistedContainers(): Promise<ContainerInstance[]>;

  // group overrides (Web UI dynamic config)
  listGroupOverrides(): Promise<GroupOverride[]>;
  getGroupOverride(groupId: string): Promise<GroupOverride | undefined>;
  upsertGroupOverride(o: GroupOverride): Promise<void>;
  deleteGroupOverride(groupId: string): Promise<void>;

  // diagnostics (aggregated — avoids N+1 pool exhaustion)
  getSessionDiagnostics(): Promise<Array<{
    session: SessionRecord;
    actualMessageCount: number;
    userMessages: number;
    assistantMessages: number;
  }>>;

  // admin
  close(): Promise<void>;
}

export function createDbStore(path: string): DbStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // --- Schema bootstrap ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      display_name TEXT NOT NULL,
      email TEXT,
      external_ids TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      sub_agent TEXT,
      container_id TEXT,
      sdk_session_id TEXT,
      platform TEXT NOT NULL,
      platform_user_id TEXT,
      platform_chat_id TEXT,
      thread_id TEXT,
      messaging_group_id TEXT,
      title TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_message_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_messaging
      ON sessions(group_id, agent_id, messaging_group_id, thread_id, platform_user_id)
      WHERE platform != 'web';

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      agent_id TEXT,
      content TEXT NOT NULL,
      tool_calls TEXT,
      usage TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS pairings (
      code TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      agent_id TEXT,
      engage_mode TEXT,
      engage_pattern TEXT,
      session_mode TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_chat_id TEXT,
      consumed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pairings_pending
      ON pairings(group_id, platform, status);

    CREATE TABLE IF NOT EXISTS messaging_groups (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      platform_chat_id TEXT NOT NULL,
      is_group INTEGER NOT NULL DEFAULT 0,
      unknown_sender_policy TEXT NOT NULL DEFAULT 'allow',
      denied_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(platform, platform_chat_id)
    );

    CREATE TABLE IF NOT EXISTS messaging_group_agents (
      messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      engage_mode TEXT NOT NULL DEFAULT 'pattern',
      engage_pattern TEXT,
      session_mode TEXT NOT NULL DEFAULT 'per-user',
      ignored_message_policy TEXT NOT NULL DEFAULT 'drop',
      created_at TEXT NOT NULL,
      PRIMARY KEY (messaging_group_id, group_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS containers (
      container_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      image_tag TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      protocol TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_overrides (
      group_id TEXT PRIMARY KEY,
      display_name TEXT,
      description TEXT,
      icon TEXT,
      enabled INTEGER,
      updated_at TEXT NOT NULL
    );
  `);

  // Migrate group_overrides table to add new columns
  for (const col of [
    'default_agent TEXT',
    'max_sessions INTEGER',
    'routing_mode TEXT',
    'routing_fallback TEXT',
    'routing_auto_classifier_model TEXT',
  ]) {
    try { db.exec(`ALTER TABLE group_overrides ADD COLUMN ${col}`); } catch { /* already exists */ }
  }

  // Migrate existing sessions table to add new columns if they don't exist
  for (const col of ['platform_chat_id TEXT', 'thread_id TEXT', 'messaging_group_id TEXT']) {
    try { db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* already exists */ }
  }

  // Migrate pairings table
  for (const col of ['agent_id TEXT', 'engage_mode TEXT', 'engage_pattern TEXT', 'session_mode TEXT']) {
    try { db.exec(`ALTER TABLE pairings ADD COLUMN ${col}`); } catch { /* already exists */ }
  }

  // Drop legacy chat_bindings table
  db.exec(`DROP TABLE IF EXISTS chat_bindings`);

  // --- prepared statements ---
  const insUser = db.prepare(`
    INSERT INTO users (id, role, display_name, email, external_ids, created_at)
    VALUES (@id, @role, @display_name, @email, @external_ids, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      role=excluded.role,
      display_name=excluded.display_name,
      email=excluded.email,
      external_ids=excluded.external_ids
  `);
  const getUserStmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
  const findUserByExt = db.prepare(
    `SELECT * FROM users WHERE json_extract(external_ids, '$.' || ?) = ?`,
  );

  const insSession = db.prepare(`
    INSERT INTO sessions (
      session_id, user_id, group_id, agent_id, sub_agent, container_id,
      sdk_session_id, platform, platform_user_id, platform_chat_id, thread_id,
      messaging_group_id, title, status, created_at, last_message_at, message_count
    ) VALUES (
      @session_id, @user_id, @group_id, @agent_id, @sub_agent, @container_id,
      @sdk_session_id, @platform, @platform_user_id, @platform_chat_id, @thread_id,
      @messaging_group_id, @title, @status, @created_at, @last_message_at, @message_count
    )
  `);
  const getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`);
  const listSessionsByUserStmt = db.prepare(
    `SELECT * FROM sessions WHERE user_id = ? ORDER BY last_message_at DESC`,
  );
  const listSessionsByUserGroupStmt = db.prepare(
    `SELECT * FROM sessions WHERE user_id = ? AND group_id = ? ORDER BY last_message_at DESC`,
  );
  const delSessionStmt = db.prepare(`DELETE FROM sessions WHERE session_id = ?`);

  const insMessage = db.prepare(`
    INSERT INTO messages (id, session_id, role, agent_id, content, tool_calls, usage, created_at)
    VALUES (@id, @session_id, @role, @agent_id, @content, @tool_calls, @usage, @created_at)
  `);
  const listMessagesStmt = db.prepare(
    `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`,
  );
  const countMessagesStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`,
  );
  const countMessagesByRoleStmt = db.prepare(
    `SELECT role, COUNT(*) AS n FROM messages WHERE session_id = ? GROUP BY role`,
  );
  const listAllSessionsStmt = db.prepare(
    `SELECT * FROM sessions ORDER BY last_message_at DESC`,
  );
  const countActiveSessionsByUserStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND status IN ('pending', 'active')`,
  );
  const deleteSessionsOlderThanStmt = db.prepare(
    `DELETE FROM sessions WHERE last_message_at < ? AND status IN ('ended', 'error')`,
  );
  const endIdleSessionsStmt = db.prepare(
    `UPDATE sessions SET status = 'ended' WHERE last_message_at < ? AND status = 'active'`,
  );
  const endStalePendingSessionsStmt = db.prepare(
    `UPDATE sessions SET status = 'ended' WHERE last_message_at < ? AND status = 'pending'`,
  );
  const listAllUsersStmt = db.prepare(`SELECT * FROM users ORDER BY created_at ASC`);

  const insPairing = db.prepare(`
    INSERT INTO pairings (code, group_id, platform, agent_id, engage_mode, engage_pattern, session_mode, status, created_at)
    VALUES (@code, @group_id, @platform, @agent_id, @engage_mode, @engage_pattern, @session_mode, @status, @created_at)
  `);
  const getPairingStmt = db.prepare(`SELECT * FROM pairings WHERE code = ?`);
  const consumePairingStmt = db.prepare(`
    UPDATE pairings SET status = 'consumed', consumed_chat_id = @chat_id, consumed_at = @consumed_at
    WHERE code = @code AND status = 'pending'
  `);
  const invalidatePendingStmt = db.prepare(`
    UPDATE pairings SET status = 'invalidated'
    WHERE group_id = @group_id AND platform = @platform AND status = 'pending'
  `);
  const listPendingPairingsStmt = db.prepare(
    `SELECT * FROM pairings WHERE status = 'pending' ORDER BY created_at DESC`,
  );

  const upsertMgStmt = db.prepare(`
    INSERT INTO messaging_groups (id, platform, platform_chat_id, is_group, unknown_sender_policy, denied_at, created_at)
    VALUES (@id, @platform, @platform_chat_id, @is_group, @unknown_sender_policy, @denied_at, @created_at)
    ON CONFLICT(platform, platform_chat_id) DO UPDATE SET
      is_group = excluded.is_group,
      unknown_sender_policy = COALESCE(excluded.unknown_sender_policy, messaging_groups.unknown_sender_policy)
  `);
  const getMgByPlatformStmt = db.prepare(
    `SELECT * FROM messaging_groups WHERE platform = ? AND platform_chat_id = ?`,
  );
  const getMgByIdStmt = db.prepare(`SELECT * FROM messaging_groups WHERE id = ?`);
  const listMgsStmt = db.prepare(`SELECT * FROM messaging_groups ORDER BY created_at DESC`);
  const delMgStmt = db.prepare(`DELETE FROM messaging_groups WHERE id = ?`);
  const listMgaStmt = db.prepare(
    `SELECT * FROM messaging_group_agents WHERE messaging_group_id = ?`,
  );
  const insMgaStmt = db.prepare(`
    INSERT INTO messaging_group_agents
      (messaging_group_id, group_id, agent_id, engage_mode, engage_pattern, session_mode, ignored_message_policy, created_at)
    VALUES (@messaging_group_id, @group_id, @agent_id, @engage_mode, @engage_pattern, @session_mode, @ignored_message_policy, @created_at)
    ON CONFLICT(messaging_group_id, group_id, agent_id) DO UPDATE SET
      engage_mode = excluded.engage_mode,
      engage_pattern = excluded.engage_pattern,
      session_mode = excluded.session_mode,
      ignored_message_policy = excluded.ignored_message_policy
  `);
  const delMgaStmt = db.prepare(
    `DELETE FROM messaging_group_agents WHERE messaging_group_id = ? AND group_id = ? AND agent_id = ?`,
  );

  const upsertContainerStmt = db.prepare(`
    INSERT INTO containers (container_id, group_id, agent_id, image_tag, host, port, protocol, status, created_at, last_activity_at)
    VALUES (@container_id, @group_id, @agent_id, @image_tag, @host, @port, @protocol, @status, @created_at, @last_activity_at)
    ON CONFLICT(container_id) DO UPDATE SET status = excluded.status, last_activity_at = excluded.last_activity_at
  `);
  const delContainerStmt = db.prepare(`DELETE FROM containers WHERE container_id = ?`);
  const listContainersStmt = db.prepare(`SELECT * FROM containers`);

  const upsertGroupOverrideStmt = db.prepare(`
    INSERT INTO group_overrides (group_id, display_name, description, icon, enabled, default_agent, max_sessions, routing_mode, routing_fallback, routing_auto_classifier_model, updated_at)
    VALUES (@group_id, @display_name, @description, @icon, @enabled, @default_agent, @max_sessions, @routing_mode, @routing_fallback, @routing_auto_classifier_model, @updated_at)
    ON CONFLICT(group_id) DO UPDATE SET
      display_name = excluded.display_name,
      description = excluded.description,
      icon = excluded.icon,
      enabled = excluded.enabled,
      default_agent = excluded.default_agent,
      max_sessions = excluded.max_sessions,
      routing_mode = excluded.routing_mode,
      routing_fallback = excluded.routing_fallback,
      routing_auto_classifier_model = excluded.routing_auto_classifier_model,
      updated_at = excluded.updated_at
  `);
  const getGroupOverrideStmt = db.prepare(`SELECT * FROM group_overrides WHERE group_id = ?`);
  const listGroupOverridesStmt = db.prepare(`SELECT * FROM group_overrides`);
  const delGroupOverrideStmt = db.prepare(`DELETE FROM group_overrides WHERE group_id = ?`);

  // --- row mappers ---
  function rowToSession(row: Record<string, unknown>): SessionRecord {
    return {
      sessionId: row['session_id'] as string,
      userId: row['user_id'] as string,
      groupId: row['group_id'] as string,
      agentId: row['agent_id'] as string,
      subAgent: (row['sub_agent'] as string | null) ?? undefined,
      containerId: (row['container_id'] as string | null) ?? null,
      sdkSessionId: (row['sdk_session_id'] as string | null) ?? null,
      platform: row['platform'] as Platform,
      platformUserId: (row['platform_user_id'] as string | null) ?? undefined,
      platformChatId: (row['platform_chat_id'] as string | null) ?? null,
      threadId: (row['thread_id'] as string | null) ?? null,
      messagingGroupId: (row['messaging_group_id'] as string | null) ?? null,
      title: (row['title'] as string | null) ?? undefined,
      status: row['status'] as SessionRecord['status'],
      createdAt: new Date(row['created_at'] as string),
      lastMessageAt: new Date(row['last_message_at'] as string),
      messageCount: row['message_count'] as number,
    };
  }

  function rowToMessage(row: Record<string, unknown>): ChatMessage {
    return {
      id: row['id'] as string,
      sessionId: row['session_id'] as string,
      role: row['role'] as ChatMessage['role'],
      agentId: (row['agent_id'] as string | null) ?? undefined,
      content: row['content'] as string,
      toolCalls: row['tool_calls'] ? JSON.parse(row['tool_calls'] as string) : undefined,
      usage: row['usage'] ? JSON.parse(row['usage'] as string) : undefined,
      createdAt: new Date(row['created_at'] as string),
    };
  }

  function rowToUser(row: Record<string, unknown>): User {
    return {
      id: row['id'] as string,
      role: row['role'] as Role,
      displayName: row['display_name'] as string,
      email: (row['email'] as string | null) ?? undefined,
      externalIds: JSON.parse(row['external_ids'] as string),
      createdAt: new Date(row['created_at'] as string),
    };
  }

  function rowToPairing(row: Record<string, unknown>): PairingCode {
    return {
      code: row['code'] as string,
      groupId: row['group_id'] as string,
      platform: row['platform'] as Platform,
      agentId: (row['agent_id'] as string | null) ?? undefined,
      engageMode: (row['engage_mode'] as EngageMode | null) ?? undefined,
      engagePattern: (row['engage_pattern'] as string | null) ?? undefined,
      sessionMode: (row['session_mode'] as SessionMode | null) ?? undefined,
      status: row['status'] as PairingCode['status'],
      createdAt: new Date(row['created_at'] as string),
      consumedChatId: (row['consumed_chat_id'] as string | null) ?? undefined,
      consumedAt: row['consumed_at'] ? new Date(row['consumed_at'] as string) : undefined,
    };
  }

  function rowToMessagingGroup(row: Record<string, unknown>): MessagingGroup {
    return {
      id: row['id'] as string,
      platform: row['platform'] as Platform,
      platformChatId: row['platform_chat_id'] as string,
      isGroup: (row['is_group'] as number) === 1,
      unknownSenderPolicy: (row['unknown_sender_policy'] as 'allow' | 'drop') ?? 'allow',
      deniedAt: (row['denied_at'] as string | null) ?? null,
      createdAt: new Date(row['created_at'] as string),
    };
  }

  function rowToMessagingGroupAgent(row: Record<string, unknown>): MessagingGroupAgent {
    return {
      messagingGroupId: row['messaging_group_id'] as string,
      groupId: row['group_id'] as string,
      agentId: row['agent_id'] as string,
      engageMode: (row['engage_mode'] as EngageMode) ?? 'pattern',
      engagePattern: (row['engage_pattern'] as string | null) ?? null,
      sessionMode: (row['session_mode'] as SessionMode) ?? 'per-user',
      ignoredMessagePolicy: (row['ignored_message_policy'] as IgnoredMessagePolicy) ?? 'drop',
      createdAt: new Date(row['created_at'] as string),
    };
  }

  function rowToContainer(row: Record<string, unknown>): ContainerInstance {
    return {
      containerId: row['container_id'] as string,
      groupId: row['group_id'] as string,
      agentId: row['agent_id'] as string,
      imageTag: row['image_tag'] as string,
      host: row['host'] as string,
      port: row['port'] as number,
      protocol: row['protocol'] as 'jsonrpc-tcp' | 'http',
      activeSdkSessions: 0,
      maxSessions: 0,
      status: row['status'] as ContainerInstance['status'],
      createdAt: new Date(row['created_at'] as string),
      lastActivityAt: new Date(row['last_activity_at'] as string),
    };
  }

  function rowToGroupOverride(row: Record<string, unknown>): GroupOverride {
    const enabled = row['enabled'];
    return {
      groupId: row['group_id'] as string,
      displayName: (row['display_name'] as string | null) ?? null,
      description: (row['description'] as string | null) ?? null,
      icon: (row['icon'] as string | null) ?? null,
      enabled: enabled === null || enabled === undefined ? null : enabled === 1 || enabled === true,
      defaultAgent: (row['default_agent'] as string | null) ?? null,
      maxSessions: (row['max_sessions'] as number | null) ?? null,
      routingMode: (row['routing_mode'] as string | null) ?? null,
      routingFallback: (row['routing_fallback'] as string | null) ?? null,
      routingAutoClassifierModel: (row['routing_auto_classifier_model'] as string | null) ?? null,
      updatedAt: new Date(row['updated_at'] as string),
    };
  }

  return {
    async createSession(s) {
      insSession.run({
        session_id: s.sessionId,
        user_id: s.userId,
        group_id: s.groupId,
        agent_id: s.agentId,
        sub_agent: s.subAgent ?? null,
        container_id: s.containerId,
        sdk_session_id: s.sdkSessionId,
        platform: s.platform,
        platform_user_id: s.platformUserId ?? null,
        platform_chat_id: s.platformChatId ?? null,
        thread_id: s.threadId ?? null,
        messaging_group_id: s.messagingGroupId ?? null,
        title: s.title ?? null,
        status: s.status,
        created_at: s.createdAt.toISOString(),
        last_message_at: s.lastMessageAt.toISOString(),
        message_count: s.messageCount,
      });
    },

    async getSession(id) {
      const row = getSessionStmt.get(id) as Record<string, unknown> | undefined;
      return row ? rowToSession(row) : undefined;
    },

    async listSessionsByUser(userId, groupId) {
      const rows = groupId
        ? (listSessionsByUserGroupStmt.all(userId, groupId) as Record<string, unknown>[])
        : (listSessionsByUserStmt.all(userId) as Record<string, unknown>[]);
      return rows.map(rowToSession);
    },

    async updateSession(id, patch) {
      const cur = getSessionStmt.get(id) as Record<string, unknown> | undefined;
      if (!cur) return;

      const fieldMap: Partial<Record<keyof SessionRecord, string>> = {
        sessionId: 'session_id', userId: 'user_id', groupId: 'group_id',
        agentId: 'agent_id', subAgent: 'sub_agent', containerId: 'container_id',
        sdkSessionId: 'sdk_session_id', platform: 'platform',
        platformUserId: 'platform_user_id', platformChatId: 'platform_chat_id',
        threadId: 'thread_id', messagingGroupId: 'messaging_group_id',
        title: 'title', status: 'status', createdAt: 'created_at',
        lastMessageAt: 'last_message_at', messageCount: 'message_count',
      };

      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      for (const k of Object.keys(patch) as Array<keyof SessionRecord>) {
        if (k === 'sessionId') continue;
        const col = fieldMap[k];
        if (!col) continue;
        const v = patch[k];
        if (v instanceof Date) {
          params[col] = v.toISOString();
        } else if (v === undefined) {
          params[col] = null;
        } else {
          params[col] = v;
        }
        sets.push(`${col} = @${col}`);
      }
      if (sets.length === 0) return;

      db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE session_id = @id`).run(params);
    },

    async deleteSession(id) {
      delSessionStmt.run(id);
    },

    async listAllSessions() {
      const rows = listAllSessionsStmt.all() as Record<string, unknown>[];
      return rows.map(rowToSession);
    },

    async countActiveSessionsByUser(userId) {
      const row = countActiveSessionsByUserStmt.get(userId) as { n: number } | undefined;
      return row?.n ?? 0;
    },

    async deleteSessionsOlderThan(before) {
      const result = deleteSessionsOlderThanStmt.run(before.toISOString());
      return result.changes;
    },

    async endIdleSessions(idleSince) {
      const result = endIdleSessionsStmt.run(idleSince.toISOString());
      return result.changes;
    },

    async endStalePendingSessions(staleSince) {
      const result = endStalePendingSessionsStmt.run(staleSince.toISOString());
      return result.changes;
    },

    async findMessagingSession({ groupId, agentId, messagingGroupId, threadId, platformUserId, sessionMode }) {
      let sql: string;
      let params: unknown[];

      switch (sessionMode) {
        case 'agent-shared':
          sql = `SELECT * FROM sessions WHERE group_id = ? AND agent_id = ? AND platform != 'web' AND status != 'expired' ORDER BY created_at ASC LIMIT 1`;
          params = [groupId, agentId];
          break;
        case 'shared':
          sql = `SELECT * FROM sessions WHERE group_id = ? AND agent_id = ? AND messaging_group_id = ? AND platform != 'web' AND status != 'expired' ORDER BY created_at ASC LIMIT 1`;
          params = [groupId, agentId, messagingGroupId];
          break;
        case 'per-thread':
          sql = threadId
            ? `SELECT * FROM sessions WHERE group_id = ? AND agent_id = ? AND messaging_group_id = ? AND thread_id = ? AND platform_user_id = ? AND platform != 'web' AND status != 'expired' ORDER BY created_at ASC LIMIT 1`
            : `SELECT * FROM sessions WHERE group_id = ? AND agent_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND platform_user_id = ? AND platform != 'web' AND status != 'expired' ORDER BY created_at ASC LIMIT 1`;
          params = threadId ? [groupId, agentId, messagingGroupId, threadId, platformUserId] : [groupId, agentId, messagingGroupId, platformUserId];
          break;
        case 'per-user':
        default:
          sql = `SELECT * FROM sessions WHERE group_id = ? AND agent_id = ? AND messaging_group_id = ? AND platform_user_id = ? AND platform != 'web' AND status != 'expired' ORDER BY created_at ASC LIMIT 1`;
          params = [groupId, agentId, messagingGroupId, platformUserId];
          break;
      }

      const row = (db.prepare(sql).get(...params)) as Record<string, unknown> | undefined;
      return row ? rowToSession(row) : undefined;
    },

    async saveMessage(m) {
      insMessage.run({
        id: m.id,
        session_id: m.sessionId,
        role: m.role,
        agent_id: m.agentId ?? null,
        content: m.content,
        tool_calls: m.toolCalls ? JSON.stringify(m.toolCalls) : null,
        usage: m.usage ? JSON.stringify(m.usage) : null,
        created_at: m.createdAt.toISOString(),
      });
    },

    async listMessages(sessionId, limit = 100) {
      const rows = listMessagesStmt.all(sessionId, limit) as Record<string, unknown>[];
      return rows.map(rowToMessage);
    },

    async countMessages(sessionId) {
      const row = countMessagesStmt.get(sessionId) as { n: number } | undefined;
      return row?.n ?? 0;
    },

    async countMessagesByRole(sessionId) {
      const rows = countMessagesByRoleStmt.all(sessionId) as Array<{ role: string; n: number }>;
      const out = { user: 0, assistant: 0 };
      for (const r of rows) {
        if (r.role === 'user') out.user = r.n;
        else if (r.role === 'assistant') out.assistant = r.n;
      }
      return out;
    },

    async getSessionDiagnostics() {
      const rows = db.prepare(`
        SELECT s.*,
               COALESCE(mc.total, 0) AS actual_message_count,
               COALESCE(mc.user_count, 0) AS user_messages,
               COALESCE(mc.assistant_count, 0) AS assistant_messages
        FROM sessions s
        LEFT JOIN (
          SELECT session_id,
                 COUNT(*) AS total,
                 SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_count,
                 SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_count
          FROM messages
          GROUP BY session_id
        ) mc ON mc.session_id = s.session_id
        ORDER BY s.last_message_at DESC
      `).all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        session: rowToSession(row),
        actualMessageCount: (row['actual_message_count'] as number) ?? 0,
        userMessages: (row['user_messages'] as number) ?? 0,
        assistantMessages: (row['assistant_messages'] as number) ?? 0,
      }));
    },

    async upsertUser(u) {
      insUser.run({
        id: u.id,
        role: u.role,
        display_name: u.displayName,
        email: u.email ?? null,
        external_ids: JSON.stringify(u.externalIds),
        created_at: u.createdAt.toISOString(),
      });
    },

    async getUser(id) {
      const row = getUserStmt.get(id) as Record<string, unknown> | undefined;
      return row ? rowToUser(row) : undefined;
    },

    async findUserByPlatformId(platform, externalId) {
      const row = findUserByExt.get(platform, externalId) as Record<string, unknown> | undefined;
      return row ? rowToUser(row) : undefined;
    },

    async listAllUsers() {
      const rows = listAllUsersStmt.all() as Record<string, unknown>[];
      return rows.map(rowToUser);
    },

    async createPairing(p) {
      insPairing.run({
        code: p.code,
        group_id: p.groupId,
        platform: p.platform,
        agent_id: p.agentId ?? null,
        engage_mode: p.engageMode ?? null,
        engage_pattern: p.engagePattern ?? null,
        session_mode: p.sessionMode ?? null,
        status: p.status,
        created_at: p.createdAt.toISOString(),
      });
    },

    async getPairing(code) {
      const row = getPairingStmt.get(code) as Record<string, unknown> | undefined;
      return row ? rowToPairing(row) : undefined;
    },

    async consumePairing(code, chatId) {
      consumePairingStmt.run({ code, chat_id: chatId, consumed_at: new Date().toISOString() });
    },

    async invalidatePendingPairings(groupId, platform) {
      invalidatePendingStmt.run({ group_id: groupId, platform });
    },

    async listPendingPairings() {
      const rows = listPendingPairingsStmt.all() as Record<string, unknown>[];
      return rows.map(rowToPairing);
    },

    async upsertMessagingGroup(mg) {
      upsertMgStmt.run({
        id: mg.id,
        platform: mg.platform,
        platform_chat_id: mg.platformChatId,
        is_group: mg.isGroup ? 1 : 0,
        unknown_sender_policy: mg.unknownSenderPolicy,
        denied_at: mg.deniedAt ?? null,
        created_at: mg.createdAt.toISOString(),
      });
      const row = getMgByPlatformStmt.get(mg.platform, mg.platformChatId) as Record<string, unknown>;
      return rowToMessagingGroup(row);
    },

    async getMessagingGroup(platform, platformChatId) {
      const row = getMgByPlatformStmt.get(platform, platformChatId) as Record<string, unknown> | undefined;
      return row ? rowToMessagingGroup(row) : undefined;
    },

    async getMessagingGroupById(id) {
      const row = getMgByIdStmt.get(id) as Record<string, unknown> | undefined;
      return row ? rowToMessagingGroup(row) : undefined;
    },

    async listMessagingGroups() {
      const groups = (listMgsStmt.all() as Record<string, unknown>[]).map(rowToMessagingGroup);
      return groups.map((mg) => {
        const wirings = (listMgaStmt.all(mg.id) as Record<string, unknown>[]).map(rowToMessagingGroupAgent);
        return { ...mg, wirings };
      });
    },

    async deleteMessagingGroup(id) {
      delMgStmt.run(id);
    },

    async updateMessagingGroup(id, patch) {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      if (patch.unknownSenderPolicy !== undefined) {
        params['policy'] = patch.unknownSenderPolicy;
        sets.push('unknown_sender_policy = @policy');
      }
      if ('deniedAt' in patch) {
        params['denied_at'] = patch.deniedAt ?? null;
        sets.push('denied_at = @denied_at');
      }
      if (sets.length === 0) return;
      db.prepare(`UPDATE messaging_groups SET ${sets.join(', ')} WHERE id = @id`).run(params);
    },

    async addMessagingGroupAgent(mga) {
      insMgaStmt.run({
        messaging_group_id: mga.messagingGroupId,
        group_id: mga.groupId,
        agent_id: mga.agentId,
        engage_mode: mga.engageMode,
        engage_pattern: mga.engagePattern ?? null,
        session_mode: mga.sessionMode,
        ignored_message_policy: mga.ignoredMessagePolicy,
        created_at: mga.createdAt.toISOString(),
      });
    },

    async updateMessagingGroupAgent(mgId, groupId, agentId, patch) {
      const sets: string[] = [];
      const params: Record<string, unknown> = { mg_id: mgId, group_id: groupId, agent_id: agentId };
      if (patch.engageMode !== undefined) { params['engage_mode'] = patch.engageMode; sets.push('engage_mode = @engage_mode'); }
      if ('engagePattern' in patch) { params['engage_pattern'] = patch.engagePattern ?? null; sets.push('engage_pattern = @engage_pattern'); }
      if (patch.sessionMode !== undefined) { params['session_mode'] = patch.sessionMode; sets.push('session_mode = @session_mode'); }
      if (patch.ignoredMessagePolicy !== undefined) { params['ignored_policy'] = patch.ignoredMessagePolicy; sets.push('ignored_message_policy = @ignored_policy'); }
      if (sets.length === 0) return;
      db.prepare(`UPDATE messaging_group_agents SET ${sets.join(', ')} WHERE messaging_group_id = @mg_id AND group_id = @group_id AND agent_id = @agent_id`).run(params);
    },

    async removeMessagingGroupAgent(mgId, groupId, agentId) {
      delMgaStmt.run(mgId, groupId, agentId);
    },

    async listMessagingGroupAgents(mgId) {
      const rows = listMgaStmt.all(mgId) as Record<string, unknown>[];
      return rows.map(rowToMessagingGroupAgent);
    },

    async upsertContainer(c) {
      upsertContainerStmt.run({
        container_id: c.containerId,
        group_id: c.groupId,
        agent_id: c.agentId,
        image_tag: c.imageTag,
        host: c.host,
        port: c.port,
        protocol: c.protocol,
        status: c.status,
        created_at: c.createdAt.toISOString(),
        last_activity_at: c.lastActivityAt.toISOString(),
      });
    },

    async removeContainer(containerId) {
      delContainerStmt.run(containerId);
    },

    async listPersistedContainers() {
      const rows = listContainersStmt.all() as Record<string, unknown>[];
      return rows.map(rowToContainer);
    },

    async listGroupOverrides() {
      const rows = listGroupOverridesStmt.all() as Record<string, unknown>[];
      return rows.map(rowToGroupOverride);
    },

    async getGroupOverride(groupId) {
      const row = getGroupOverrideStmt.get(groupId) as Record<string, unknown> | undefined;
      return row ? rowToGroupOverride(row) : undefined;
    },

    async upsertGroupOverride(o) {
      upsertGroupOverrideStmt.run({
        group_id: o.groupId,
        display_name: o.displayName ?? null,
        description: o.description ?? null,
        icon: o.icon ?? null,
        enabled: o.enabled === null || o.enabled === undefined ? null : (o.enabled ? 1 : 0),
        default_agent: o.defaultAgent ?? null,
        max_sessions: o.maxSessions ?? null,
        routing_mode: o.routingMode ?? null,
        routing_fallback: o.routingFallback ?? null,
        routing_auto_classifier_model: o.routingAutoClassifierModel ?? null,
        updated_at: o.updatedAt.toISOString(),
      });
    },

    async deleteGroupOverride(groupId) {
      delGroupOverrideStmt.run(groupId);
    },

    async close() {
      db.close();
    },
  };
}