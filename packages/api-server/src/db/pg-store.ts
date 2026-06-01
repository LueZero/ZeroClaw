/**
 * PostgreSQL store — implements DbStore using the `pg` package.
 *
 * Usage:
 *   import { createPgDbStore } from './pg-store.js';
 *   const db = await createPgDbStore(process.env.DATABASE_URL!);
 *
 * Requires DATABASE_URL in the standard postgres://user:pass@host:5432/dbname format.
 * All DDL uses IF NOT EXISTS so it is idempotent on every startup.
 */

import pg from 'pg';
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
  ToolCallRecord,
  TokenUsage,
  GroupOverride,
} from '@zeroclaw/shared';
import type { DbStore, PairingCode, FindMessagingSessionParams } from './db-store.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT,
    external_ids JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL
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
    created_at TIMESTAMPTZ NOT NULL,
    last_message_at TIMESTAMPTZ NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_messaging
    ON sessions(group_id, agent_id, messaging_group_id, thread_id, platform_user_id)
    WHERE platform != 'web';

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    agent_id TEXT,
    content TEXT NOT NULL,
    tool_calls JSONB,
    usage JSONB,
    created_at TIMESTAMPTZ NOT NULL
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
    created_at TIMESTAMPTZ NOT NULL,
    consumed_chat_id TEXT,
    consumed_at TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_pairings_pending ON pairings(group_id, platform, status);

  CREATE TABLE IF NOT EXISTS messaging_groups (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    platform_chat_id TEXT NOT NULL,
    is_group BOOLEAN NOT NULL DEFAULT FALSE,
    unknown_sender_policy TEXT NOT NULL DEFAULT 'allow',
    denied_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
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
    created_at TIMESTAMPTZ NOT NULL,
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
    created_at TIMESTAMPTZ NOT NULL,
    last_activity_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_overrides (
    group_id TEXT PRIMARY KEY,
    display_name TEXT,
    description TEXT,
    icon TEXT,
    enabled BOOLEAN,
    default_agent TEXT,
    max_sessions INTEGER,
    routing_mode TEXT,
    routing_fallback TEXT,
    routing_auto_classifier_model TEXT,
    updated_at TIMESTAMPTZ NOT NULL
  );

  -- Drop legacy table if it somehow exists
  DROP TABLE IF EXISTS chat_bindings;
`;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------
// pg returns JS Date objects for TIMESTAMPTZ columns automatically.
// JSONB columns come back as parsed JS objects.

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
    createdAt: row['created_at'] as Date,
    lastMessageAt: row['last_message_at'] as Date,
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
    toolCalls: (row['tool_calls'] as ToolCallRecord[] | null) ?? undefined,
    usage: (row['usage'] as TokenUsage | null) ?? undefined,
    createdAt: row['created_at'] as Date,
  };
}

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: row['id'] as string,
    role: row['role'] as Role,
    displayName: row['display_name'] as string,
    email: (row['email'] as string | null) ?? undefined,
    externalIds: row['external_ids'] as Record<string, string | undefined>,
    createdAt: row['created_at'] as Date,
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
    createdAt: row['created_at'] as Date,
    consumedChatId: (row['consumed_chat_id'] as string | null) ?? undefined,
    consumedAt: (row['consumed_at'] as Date | null) ?? undefined,
  };
}

function rowToMessagingGroup(row: Record<string, unknown>): MessagingGroup {
  return {
    id: row['id'] as string,
    platform: row['platform'] as Platform,
    platformChatId: row['platform_chat_id'] as string,
    isGroup: row['is_group'] as boolean,
    unknownSenderPolicy: (row['unknown_sender_policy'] as 'allow' | 'drop') ?? 'allow',
    deniedAt: (row['denied_at'] as string | null) ?? null,
    createdAt: row['created_at'] as Date,
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
    createdAt: row['created_at'] as Date,
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
    createdAt: row['created_at'] as Date,
    lastActivityAt: row['last_activity_at'] as Date,
  };
}

function rowToGroupOverride(row: Record<string, unknown>): GroupOverride {
  const enabled = row['enabled'];
  return {
    groupId: row['group_id'] as string,
    displayName: (row['display_name'] as string | null) ?? null,
    description: (row['description'] as string | null) ?? null,
    icon: (row['icon'] as string | null) ?? null,
    enabled: enabled === null || enabled === undefined ? null : Boolean(enabled),
    defaultAgent: (row['default_agent'] as string | null) ?? null,
    maxSessions: (row['max_sessions'] as number | null) ?? null,
    routingMode: (row['routing_mode'] as string | null) ?? null,
    routingFallback: (row['routing_fallback'] as string | null) ?? null,
    routingAutoClassifierModel: (row['routing_auto_classifier_model'] as string | null) ?? null,
    updatedAt: row['updated_at'] as Date,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and initialize a PostgreSQL-backed DbStore.
 * Runs all DDL on first call; safe to call on every startup (IF NOT EXISTS).
 */
export async function createPgDbStore(connectionString: string): Promise<DbStore> {
  const pool = new Pool({ connectionString });

  // Verify connection
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    // Migrate existing group_overrides table (add new columns for pre-existing DBs)
    for (const col of [
      'default_agent TEXT',
      'max_sessions INTEGER',
      'routing_mode TEXT',
      'routing_fallback TEXT',
      'routing_auto_classifier_model TEXT',
    ]) {
      try { await client.query(`ALTER TABLE group_overrides ADD COLUMN IF NOT EXISTS ${col}`); } catch { /* ignore */ }
    }
  } finally {
    client.release();
  }

  // Helper: run a query and return rows
  async function q<T extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<T[]> {
    const res = await pool.query(text, values);
    return res.rows as T[];
  }

  // Helper: run a query and return first row or undefined
  async function q1<T extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<T | undefined> {
    const res = await pool.query(text, values);
    return res.rows[0] as T | undefined;
  }

  return {
    // ---- sessions ----
    async createSession(s) {
      await pool.query(
        `INSERT INTO sessions (
          session_id, user_id, group_id, agent_id, sub_agent, container_id,
          sdk_session_id, platform, platform_user_id, platform_chat_id, thread_id,
          messaging_group_id, title, status, created_at, last_message_at, message_count
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (session_id) DO NOTHING`,
        [
          s.sessionId, s.userId, s.groupId, s.agentId, s.subAgent ?? null,
          s.containerId, s.sdkSessionId, s.platform,
          s.platformUserId ?? null, s.platformChatId ?? null,
          s.threadId ?? null, s.messagingGroupId ?? null,
          s.title ?? null, s.status,
          s.createdAt, s.lastMessageAt, s.messageCount,
        ],
      );
    },

    async getSession(id) {
      const row = await q1(`SELECT * FROM sessions WHERE session_id = $1`, [id]);
      return row ? rowToSession(row) : undefined;
    },

    async listSessionsByUser(userId, groupId) {
      const rows = groupId
        ? await q(`SELECT * FROM sessions WHERE user_id = $1 AND group_id = $2 ORDER BY last_message_at DESC`, [userId, groupId])
        : await q(`SELECT * FROM sessions WHERE user_id = $1 ORDER BY last_message_at DESC`, [userId]);
      return rows.map(rowToSession);
    },

    async updateSession(id, patch) {
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
      const values: unknown[] = [];
      let idx = 1;

      for (const k of Object.keys(patch) as Array<keyof SessionRecord>) {
        if (k === 'sessionId') continue;
        const col = fieldMap[k];
        if (!col) continue;
        const v = patch[k];
        values.push(v instanceof Date ? v : (v === undefined ? null : v));
        sets.push(`${col} = $${idx++}`);
      }
      if (sets.length === 0) return;
      values.push(id);
      await pool.query(
        `UPDATE sessions SET ${sets.join(', ')} WHERE session_id = $${idx}`,
        values,
      );
    },

    async deleteSession(id) {
      await pool.query(`DELETE FROM sessions WHERE session_id = $1`, [id]);
    },

    async listAllSessions() {
      const rows = await q(`SELECT * FROM sessions ORDER BY last_message_at DESC`);
      return rows.map(rowToSession);
    },

    async countActiveSessionsByUser(userId) {
      const r = await q1(`SELECT COUNT(*)::int AS n FROM sessions WHERE user_id=$1 AND status IN ('pending','active')`, [userId]);
      return (r as { n: number } | undefined)?.n ?? 0;
    },

    async deleteSessionsOlderThan(before) {
      const r = await pool.query(`DELETE FROM sessions WHERE last_message_at < $1 AND status IN ('ended','error')`, [before]);
      return r.rowCount ?? 0;
    },

    async endIdleSessions(idleSince) {
      const r = await pool.query(`UPDATE sessions SET status='ended' WHERE last_message_at < $1 AND status = 'active'`, [idleSince]);
      return r.rowCount ?? 0;
    },

    async endStalePendingSessions(staleSince) {
      const r = await pool.query(`UPDATE sessions SET status='ended' WHERE last_message_at < $1 AND status = 'pending'`, [staleSince]);
      return r.rowCount ?? 0;
    },

    async findMessagingSession({ groupId, agentId, messagingGroupId, threadId, platformUserId, sessionMode }) {
      let row: Record<string, unknown> | undefined;

      switch (sessionMode) {
        case 'agent-shared':
          row = await q1(
            `SELECT * FROM sessions WHERE group_id=$1 AND agent_id=$2 AND platform!='web' AND status!='expired' ORDER BY created_at ASC LIMIT 1`,
            [groupId, agentId],
          );
          break;
        case 'shared':
          row = await q1(
            `SELECT * FROM sessions WHERE group_id=$1 AND agent_id=$2 AND messaging_group_id=$3 AND platform!='web' AND status!='expired' ORDER BY created_at ASC LIMIT 1`,
            [groupId, agentId, messagingGroupId],
          );
          break;
        case 'per-thread':
          if (threadId) {
            row = await q1(
              `SELECT * FROM sessions WHERE group_id=$1 AND agent_id=$2 AND messaging_group_id=$3 AND thread_id=$4 AND platform_user_id=$5 AND platform!='web' AND status!='expired' ORDER BY created_at ASC LIMIT 1`,
              [groupId, agentId, messagingGroupId, threadId, platformUserId],
            );
          } else {
            row = await q1(
              `SELECT * FROM sessions WHERE group_id=$1 AND agent_id=$2 AND messaging_group_id=$3 AND thread_id IS NULL AND platform_user_id=$4 AND platform!='web' AND status!='expired' ORDER BY created_at ASC LIMIT 1`,
              [groupId, agentId, messagingGroupId, platformUserId],
            );
          }
          break;
        case 'per-user':
        default:
          row = await q1(
            `SELECT * FROM sessions WHERE group_id=$1 AND agent_id=$2 AND messaging_group_id=$3 AND platform_user_id=$4 AND platform!='web' AND status!='expired' ORDER BY created_at ASC LIMIT 1`,
            [groupId, agentId, messagingGroupId, platformUserId],
          );
          break;
      }

      return row ? rowToSession(row) : undefined;
    },

    // ---- messages ----
    async saveMessage(m) {
      await pool.query(
        `INSERT INTO messages (id, session_id, role, agent_id, content, tool_calls, usage, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [
          m.id, m.sessionId, m.role, m.agentId ?? null,
          m.content,
          m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          m.usage ? JSON.stringify(m.usage) : null,
          m.createdAt,
        ],
      );
    },

    async listMessages(sessionId, limit = 100) {
      const rows = await q(
        `SELECT * FROM messages WHERE session_id=$1 ORDER BY created_at ASC LIMIT $2`,
        [sessionId, limit],
      );
      return rows.map(rowToMessage);
    },

    async countMessages(sessionId) {
      const row = await q1<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM messages WHERE session_id=$1`,
        [sessionId],
      );
      return parseInt(row?.n ?? '0', 10);
    },

    async countMessagesByRole(sessionId) {
      const rows = await q<{ role: string; n: string }>(
        `SELECT role, COUNT(*)::text AS n FROM messages WHERE session_id=$1 GROUP BY role`,
        [sessionId],
      );
      const out = { user: 0, assistant: 0 };
      for (const r of rows) {
        if (r.role === 'user') out.user = parseInt(r.n, 10);
        else if (r.role === 'assistant') out.assistant = parseInt(r.n, 10);
      }
      return out;
    },

    async getSessionDiagnostics() {
      const rows = await q<Record<string, unknown>>(
        `SELECT s.*,
                COALESCE(mc.total, 0)::int AS actual_message_count,
                COALESCE(mc.user_count, 0)::int AS user_messages,
                COALESCE(mc.assistant_count, 0)::int AS assistant_messages
         FROM sessions s
         LEFT JOIN (
           SELECT session_id,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE role = 'user')::int AS user_count,
                  COUNT(*) FILTER (WHERE role = 'assistant')::int AS assistant_count
           FROM messages
           GROUP BY session_id
         ) mc ON mc.session_id = s.session_id
         ORDER BY s.last_message_at DESC`,
      );
      return rows.map((row) => ({
        session: rowToSession(row),
        actualMessageCount: row['actual_message_count'] as number,
        userMessages: row['user_messages'] as number,
        assistantMessages: row['assistant_messages'] as number,
      }));
    },

    // ---- users ----
    async upsertUser(u) {
      await pool.query(
        `INSERT INTO users (id, role, display_name, email, external_ids, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET
           role=EXCLUDED.role,
           display_name=EXCLUDED.display_name,
           email=EXCLUDED.email,
           external_ids=EXCLUDED.external_ids`,
        [u.id, u.role, u.displayName, u.email ?? null, JSON.stringify(u.externalIds), u.createdAt],
      );
    },

    async getUser(id) {
      const row = await q1(`SELECT * FROM users WHERE id=$1`, [id]);
      return row ? rowToUser(row) : undefined;
    },

    async findUserByPlatformId(platform, externalId) {
      const row = await q1(
        `SELECT * FROM users WHERE external_ids->>$1 = $2`,
        [platform, externalId],
      );
      return row ? rowToUser(row) : undefined;
    },

    async listAllUsers() {
      const rows = await q(`SELECT * FROM users ORDER BY created_at ASC`);
      return rows.map(rowToUser);
    },

    // ---- pairings ----
    async createPairing(p) {
      await pool.query(
        `INSERT INTO pairings (code, group_id, platform, agent_id, engage_mode, engage_pattern, session_mode, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          p.code, p.groupId, p.platform,
          p.agentId ?? null, p.engageMode ?? null, p.engagePattern ?? null,
          p.sessionMode ?? null, p.status, p.createdAt,
        ],
      );
    },

    async getPairing(code) {
      const row = await q1(`SELECT * FROM pairings WHERE code=$1`, [code]);
      return row ? rowToPairing(row) : undefined;
    },

    async consumePairing(code, chatId) {
      await pool.query(
        `UPDATE pairings SET status='consumed', consumed_chat_id=$1, consumed_at=NOW()
         WHERE code=$2 AND status='pending'`,
        [chatId, code],
      );
    },

    async invalidatePendingPairings(groupId, platform) {
      await pool.query(
        `UPDATE pairings SET status='invalidated'
         WHERE group_id=$1 AND platform=$2 AND status='pending'`,
        [groupId, platform],
      );
    },

    async listPendingPairings() {
      const rows = await q(
        `SELECT * FROM pairings WHERE status='pending' ORDER BY created_at DESC`,
      );
      return rows.map(rowToPairing);
    },

    // ---- messaging groups ----
    async upsertMessagingGroup(mg) {
      await pool.query(
        `INSERT INTO messaging_groups (id, platform, platform_chat_id, is_group, unknown_sender_policy, denied_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (platform, platform_chat_id) DO UPDATE SET
           is_group=EXCLUDED.is_group,
           unknown_sender_policy=COALESCE(EXCLUDED.unknown_sender_policy, messaging_groups.unknown_sender_policy)`,
        [
          mg.id, mg.platform, mg.platformChatId, mg.isGroup,
          mg.unknownSenderPolicy, mg.deniedAt ?? null, mg.createdAt,
        ],
      );
      const row = await q1(
        `SELECT * FROM messaging_groups WHERE platform=$1 AND platform_chat_id=$2`,
        [mg.platform, mg.platformChatId],
      );
      return rowToMessagingGroup(row!);
    },

    async getMessagingGroup(platform, platformChatId) {
      const row = await q1(
        `SELECT * FROM messaging_groups WHERE platform=$1 AND platform_chat_id=$2`,
        [platform, platformChatId],
      );
      return row ? rowToMessagingGroup(row) : undefined;
    },

    async getMessagingGroupById(id) {
      const row = await q1(`SELECT * FROM messaging_groups WHERE id=$1`, [id]);
      return row ? rowToMessagingGroup(row) : undefined;
    },

    async listMessagingGroups() {
      const groups = (await q(`SELECT * FROM messaging_groups ORDER BY created_at DESC`)).map(rowToMessagingGroup);
      const result: MessagingGroupWithWirings[] = [];
      for (const mg of groups) {
        const wirings = (await q(
          `SELECT * FROM messaging_group_agents WHERE messaging_group_id=$1`,
          [mg.id],
        )).map(rowToMessagingGroupAgent);
        result.push({ ...mg, wirings });
      }
      return result;
    },

    async deleteMessagingGroup(id) {
      await pool.query(`DELETE FROM messaging_groups WHERE id=$1`, [id]);
    },

    async updateMessagingGroup(id, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (patch.unknownSenderPolicy !== undefined) {
        sets.push(`unknown_sender_policy = $${idx++}`);
        values.push(patch.unknownSenderPolicy);
      }
      if ('deniedAt' in patch) {
        sets.push(`denied_at = $${idx++}`);
        values.push(patch.deniedAt ?? null);
      }
      if (sets.length === 0) return;
      values.push(id);
      await pool.query(
        `UPDATE messaging_groups SET ${sets.join(', ')} WHERE id = $${idx}`,
        values,
      );
    },

    // ---- messaging group agents (wirings) ----
    async addMessagingGroupAgent(mga) {
      await pool.query(
        `INSERT INTO messaging_group_agents
          (messaging_group_id, group_id, agent_id, engage_mode, engage_pattern, session_mode, ignored_message_policy, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (messaging_group_id, group_id, agent_id) DO UPDATE SET
           engage_mode=EXCLUDED.engage_mode,
           engage_pattern=EXCLUDED.engage_pattern,
           session_mode=EXCLUDED.session_mode,
           ignored_message_policy=EXCLUDED.ignored_message_policy`,
        [
          mga.messagingGroupId, mga.groupId, mga.agentId,
          mga.engageMode, mga.engagePattern ?? null,
          mga.sessionMode, mga.ignoredMessagePolicy, mga.createdAt,
        ],
      );
    },

    async updateMessagingGroupAgent(mgId, groupId, agentId, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (patch.engageMode !== undefined) { sets.push(`engage_mode=$${idx++}`); values.push(patch.engageMode); }
      if ('engagePattern' in patch) { sets.push(`engage_pattern=$${idx++}`); values.push(patch.engagePattern ?? null); }
      if (patch.sessionMode !== undefined) { sets.push(`session_mode=$${idx++}`); values.push(patch.sessionMode); }
      if (patch.ignoredMessagePolicy !== undefined) { sets.push(`ignored_message_policy=$${idx++}`); values.push(patch.ignoredMessagePolicy); }
      if (sets.length === 0) return;
      values.push(mgId, groupId, agentId);
      await pool.query(
        `UPDATE messaging_group_agents SET ${sets.join(', ')}
         WHERE messaging_group_id=$${idx} AND group_id=$${idx + 1} AND agent_id=$${idx + 2}`,
        values,
      );
    },

    async removeMessagingGroupAgent(mgId, groupId, agentId) {
      await pool.query(
        `DELETE FROM messaging_group_agents WHERE messaging_group_id=$1 AND group_id=$2 AND agent_id=$3`,
        [mgId, groupId, agentId],
      );
    },

    async listMessagingGroupAgents(mgId) {
      const rows = await q(
        `SELECT * FROM messaging_group_agents WHERE messaging_group_id=$1`,
        [mgId],
      );
      return rows.map(rowToMessagingGroupAgent);
    },

    // ---- containers ----
    async upsertContainer(c) {
      await pool.query(
        `INSERT INTO containers (container_id, group_id, agent_id, image_tag, host, port, protocol, status, created_at, last_activity_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (container_id) DO UPDATE SET
           status=EXCLUDED.status,
           last_activity_at=EXCLUDED.last_activity_at`,
        [
          c.containerId, c.groupId, c.agentId, c.imageTag,
          c.host, c.port, c.protocol, c.status,
          c.createdAt, c.lastActivityAt,
        ],
      );
    },

    async removeContainer(containerId) {
      await pool.query(`DELETE FROM containers WHERE container_id=$1`, [containerId]);
    },

    async listPersistedContainers() {
      const rows = await q(`SELECT * FROM containers`);
      return rows.map(rowToContainer);
    },

    async listGroupOverrides() {
      const rows = await q(`SELECT * FROM group_overrides`);
      return rows.map(rowToGroupOverride);
    },

    async getGroupOverride(groupId) {
      const rows = await q(`SELECT * FROM group_overrides WHERE group_id=$1`, [groupId]);
      return rows[0] ? rowToGroupOverride(rows[0]) : undefined;
    },

    async upsertGroupOverride(o) {
      await pool.query(
        `INSERT INTO group_overrides (group_id, display_name, description, icon, enabled, default_agent, max_sessions, routing_mode, routing_fallback, routing_auto_classifier_model, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (group_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description = EXCLUDED.description,
           icon = EXCLUDED.icon,
           enabled = EXCLUDED.enabled,
           default_agent = EXCLUDED.default_agent,
           max_sessions = EXCLUDED.max_sessions,
           routing_mode = EXCLUDED.routing_mode,
           routing_fallback = EXCLUDED.routing_fallback,
           routing_auto_classifier_model = EXCLUDED.routing_auto_classifier_model,
           updated_at = EXCLUDED.updated_at`,
        [
          o.groupId,
          o.displayName ?? null,
          o.description ?? null,
          o.icon ?? null,
          o.enabled === null || o.enabled === undefined ? null : o.enabled,
          o.defaultAgent ?? null,
          o.maxSessions ?? null,
          o.routingMode ?? null,
          o.routingFallback ?? null,
          o.routingAutoClassifierModel ?? null,
          o.updatedAt,
        ],
      );
    },

    async deleteGroupOverride(groupId) {
      await pool.query(`DELETE FROM group_overrides WHERE group_id=$1`, [groupId]);
    },

    async close() {
      await pool.end();
    },
  };
}
