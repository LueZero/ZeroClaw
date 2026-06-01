/**
 * Zustand store — auth, groups, agents, sessions, chat messages, ws connection
 */

import { create } from 'zustand';
import type {
  WsClientMessage,
  WsServerMessage,
  SessionRecord,
} from '@zeroclaw/shared';

/**
 * 在前端解析 JWT payload（不驗簽，僅供 UI 顯示用）
 *
 * - 真正的權限驗證仍由 API server 進行；client 解析只是為了：
 *   1. 在 /admin route 阻擋非 admin 使用者，提早顯示友善訊息
 *   2. UI 可顯示當前登入身份
 */
function decodeJwtPayload(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decodeJwtRole(token: string | null): 'admin' | 'member' | 'guest' | null {
  const p = decodeJwtPayload(token);
  if (!p) return null;
  const r = p['role'];
  return r === 'admin' || r === 'member' || r === 'guest' ? r : 'member';
}

function decodeJwtSub(token: string | null): string | null {
  const p = decodeJwtPayload(token);
  return typeof p?.['sub'] === 'string' ? (p['sub'] as string) : null;
}

interface GroupSummary {
  id: string;
  displayName: string;
  description?: string;
  icon?: string;
  defaultAgent?: string;
  agents: string[];
}

interface AgentSummary {
  id: string;
  sdk: 'opencode' | 'copilot';
  displayName: string;
  description?: string;
  avatar?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  agentId?: string;
  /** 行內工具呼叫卡片 */
  toolCalls?: ToolCallEntry[];
}

interface ToolCallEntry {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  status: 'running' | 'completed' | 'error';
  result?: string;
}

interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  description: string;
}

interface ElicitationRequest {
  requestId: string;
  sessionId: string;
  question: string;
  options?: string[];
}

export type { ChatMessage, ToolCallEntry, ApprovalRequest, ElicitationRequest, GroupSummary, AgentSummary };

// ─── Messaging Groups types ───────────────────────────────────────────────────
export interface WiringRecord {
  messagingGroupId: string;
  groupId: string;
  agentId: string;
  engageMode: 'pattern' | 'mention' | 'mention-sticky';
  engagePattern: string | null;
  sessionMode: 'per-user' | 'per-thread' | 'shared' | 'agent-shared';
  ignoredMessagePolicy: 'drop' | 'accumulate';
  createdAt: string;
}

export interface MessagingGroupRecord {
  id: string;
  platform: string;
  platformChatId: string;
  isGroup: boolean;
  unknownSenderPolicy: 'allow' | 'drop';
  deniedAt: string | null;
  createdAt: string;
  wirings: WiringRecord[];
}

export interface WiringInput {
  groupId: string;
  agentId: string;
  engageMode: 'pattern' | 'mention' | 'mention-sticky';
  engagePattern?: string;
  sessionMode?: 'per-user' | 'per-thread' | 'shared' | 'agent-shared';
  ignoredMessagePolicy?: 'drop' | 'accumulate';
}

/**
 * Admin view of a group: yaml-defined config + DB override status.
 */
export interface AdminGroupRecord {
  id: string;
  displayName: string;
  description?: string;
  icon?: string;
  enabled: boolean;
  agents: string[];
  defaultAgent?: string;
  baseImage: string;
  maxSessions: number;
  cpuLimit: string | null;
  memoryLimit: string | null;
  routingMode: 'explicit' | 'auto' | 'round-robin';
  routingFallback?: string;
  routingAutoClassifierModel?: string;
  hasOverride: boolean;
  override: {
    groupId: string;
    displayName: string | null;
    description: string | null;
    icon: string | null;
    enabled: boolean | null;
    defaultAgent: string | null;
    maxSessions: number | null;
    routingMode: string | null;
    routingFallback: string | null;
    routingAutoClassifierModel: string | null;
    updatedAt: string;
  } | null;
}

export interface AdminGroupPatch {
  displayName?: string;
  description?: string;
  icon?: string;
  enabled?: boolean;
  defaultAgent?: string;
  maxSessions?: number;
  routingMode?: 'explicit' | 'auto' | 'round-robin';
  routingFallback?: string | null;
  routingAutoClassifierModel?: string | null;
}

interface State {
  token: string | null;
  /** 從 JWT 解析出的當前使用者角色（admin / member / guest）；無 token 時為 null */
  role: 'admin' | 'member' | 'guest' | null;
  /** 從 JWT 解析出的當前 user id；無 token 時為 null */
  userId: string | null;
  groups: GroupSummary[];
  agents: Record<string, AgentSummary[]>;
  sessions: SessionRecord[];
  currentSessionId: string | null;
  messages: Record<string, ChatMessage[]>;
  ws: WebSocket | null;
  streaming: boolean;

  /** 待審核 approval list */
  pendingApprovals: ApprovalRequest[];
  /** 待回覆 elicitation list */
  pendingElicitations: ElicitationRequest[];
  /** Admin: messaging groups */
  messagingGroups: MessagingGroupRecord[];
  /** Admin: yaml-defined groups + DB override status */
  adminGroups: AdminGroupRecord[];

  setToken(t: string | null): void;
  api<T>(path: string, init?: RequestInit): Promise<T>;
  loadGroups(): Promise<void>;
  loadAgentsForGroup(groupId: string): Promise<void>;
  loadSessions(): Promise<void>;
  createSession(groupId: string, agentId?: string): Promise<SessionRecord>;
  selectSession(id: string): Promise<void>;
  loadMessages(id: string): Promise<void>;
  connectWs(): void;
  sendUserMessage(text: string): void;
  abort(): void;
  deleteSession(id: string): Promise<void>;
  resolveApproval(requestId: string, approved: boolean): void;
  resolveElicitation(requestId: string, answer: string): void;
  // messaging groups CRUD
  loadMessagingGroups(): Promise<void>;
  createMessagingGroup(mg: { platform: string; platformChatId: string; isGroup: boolean }): Promise<MessagingGroupRecord>;
  deleteMessagingGroup(id: string): Promise<void>;
  updateMessagingGroup(id: string, patch: { unknownSenderPolicy?: 'allow' | 'drop'; denied?: boolean }): Promise<void>;
  addWiring(mgId: string, wiring: WiringInput): Promise<void>;
  updateWiring(mgId: string, groupId: string, agentId: string, patch: Partial<WiringInput>): Promise<void>;
  removeWiring(mgId: string, groupId: string, agentId: string): Promise<void>;
  createPairing(input: { groupId: string; platform: string; agentId?: string; engageMode?: string; engagePattern?: string; sessionMode?: string }): Promise<{ code: string; groupId: string; platform: string; agentId: string | null; engageMode: string | null; sessionMode: string | null; status: string; createdAt: string }>;
  // admin: groups (yaml + override)
  loadAdminGroups(): Promise<void>;
  patchAdminGroup(id: string, patch: AdminGroupPatch): Promise<void>;
  resetAdminGroup(id: string): Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  token: localStorage.getItem('nc.token'),
  role: decodeJwtRole(localStorage.getItem('nc.token')),
  userId: decodeJwtSub(localStorage.getItem('nc.token')),
  groups: [],
  agents: {},
  sessions: [],
  currentSessionId: null,
  messages: {},
  ws: null,
  streaming: false,
  pendingApprovals: [],
  pendingElicitations: [],
  messagingGroups: [],
  adminGroups: [],

  setToken(t) {
    if (t) localStorage.setItem('nc.token', t);
    else localStorage.removeItem('nc.token');
    // Close existing WebSocket on token change (re-login / logout)
    const oldWs = get().ws;
    if (oldWs) {
      try { oldWs.close(); } catch { /* ignore */ }
    }
    set({
      token: t,
      role: decodeJwtRole(t),
      userId: decodeJwtSub(t),
      ws: null,
      sessions: [],
      currentSessionId: null,
      messages: {},
      pendingApprovals: [],
      pendingElicitations: [],
      streaming: false,
    });
  },

  async api<T>(path: string, init?: RequestInit): Promise<T> {
    const token = get().token;
    const res = await fetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const err = new Error(`API ${path} failed: ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  },

  async loadGroups() {
    const groups = await get().api<GroupSummary[]>('/api/groups');
    set({ groups });
  },

  async loadAgentsForGroup(groupId) {
    const list = await get().api<AgentSummary[]>(`/api/groups/${groupId}/agents`);
    set((s) => ({ agents: { ...s.agents, [groupId]: list } }));
  },

  async loadSessions() {
    const sessions = await get().api<SessionRecord[]>('/api/sessions');
    set({ sessions });
  },

  async createSession(groupId, agentId) {
    const session = await get().api<SessionRecord>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ groupId, agentId }),
    });
    // 直接插入新 session 到列表（避免 race condition）
    set((s) => ({ sessions: [session, ...s.sessions] }));
    await get().selectSession(session.sessionId);
    return session;
  },

  async selectSession(id) {
    const prevId = get().currentSessionId;
    const ws = get().ws;
    // Unsubscribe from previous session
    if (prevId && prevId !== id && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'unsubscribe', sessionId: prevId } as WsClientMessage));
    }
    set({ currentSessionId: id });

    // If re-selecting the same session (e.g. navigating back from another page) and
    // there's an active streaming message, skip loadMessages to avoid losing live chunks.
    const existing = get().messages[id];
    if (prevId === id && existing?.some((m) => m.id === '__streaming__')) {
      // Already receiving live stream — just ensure subscription is active
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'subscribe', sessionId: id } as WsClientMessage));
      }
      return;
    }

    await get().loadMessages(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', sessionId: id } as WsClientMessage));
    }
    // If WS isn't open yet, onopen handler will auto-subscribe
  },

  async loadMessages(id) {
    type ApiMessage = { id: string; role: 'user' | 'assistant'; content: string; agentId?: string };
    const list = await get().api<ApiMessage[]>(`/api/sessions/${id}/messages`);
    set((s) => ({
      messages: {
        ...s.messages,
        [id]: list.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          agentId: m.agentId,
        })),
      },
    }));
  },

  async deleteSession(id) {
    await get().api(`/api/sessions/${id}`, { method: 'DELETE' });
    set((s) => {
      const sessions = s.sessions.filter((ss) => ss.sessionId !== id);
      const currentSessionId = s.currentSessionId === id ? null : s.currentSessionId;
      const messages = { ...s.messages };
      delete messages[id];
      return { sessions, currentSessionId, messages };
    });
  },

  connectWs() {
    if (get().ws) return;
    const token = get().token;
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      // Re-subscribe to current session after reconnect so streaming events resume
      const sid = get().currentSessionId;
      if (sid) {
        // Load persisted messages first, then subscribe for live events
        void get().loadMessages(sid).then(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid } as WsClientMessage));
          }
        });
      }
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as WsServerMessage;
      handleWsMessage(msg, set, get);
    };
    ws.onclose = () => {
      set({ ws: null });
      // Auto-reconnect after 3s if still logged in
      const tok = get().token;
      if (tok) {
        setTimeout(() => {
          if (!get().ws && get().token) get().connectWs();
        }, 3000);
      }
    };
    ws.onerror = () => {
      // error is followed by onclose — reconnect handled there
    };
    set({ ws });
  },

  sendUserMessage(text) {
    const { ws, currentSessionId, messages } = get();
    if (!ws || !currentSessionId) return;
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
    };
    const list = messages[currentSessionId] ?? [];
    set({
      messages: { ...messages, [currentSessionId]: [...list, userMsg] },
      streaming: true,
    });
    ws.send(
      JSON.stringify({
        type: 'user.message',
        sessionId: currentSessionId,
        text,
      } as WsClientMessage),
    );
  },

  abort() {
    const { ws, currentSessionId } = get();
    if (!ws || !currentSessionId) return;
    ws.send(
      JSON.stringify({
        type: 'user.abort',
        sessionId: currentSessionId,
      } as WsClientMessage),
    );
  },

  resolveApproval(requestId, approved) {
    const { ws, currentSessionId } = get();
    if (!ws || !currentSessionId) return;
    ws.send(
      JSON.stringify({
        type: 'user.approval',
        sessionId: currentSessionId,
        requestId,
        approved,
      } as WsClientMessage),
    );
    set((s) => ({
      pendingApprovals: s.pendingApprovals.filter((a) => a.requestId !== requestId),
    }));
  },

  resolveElicitation(requestId, answer) {
    const { ws, currentSessionId } = get();
    if (!ws || !currentSessionId) return;
    ws.send(
      JSON.stringify({
        type: 'user.elicitation',
        sessionId: currentSessionId,
        requestId,
        answer,
      } as WsClientMessage),
    );
    set((s) => ({
      pendingElicitations: s.pendingElicitations.filter((e) => e.requestId !== requestId),
    }));
  },

  // ─── Messaging Groups ────────────────────────────────────────────────────────
  async loadMessagingGroups() {
    const groups = await get().api<MessagingGroupRecord[]>('/api/admin/messaging-groups');
    set({ messagingGroups: groups });
  },

  async createMessagingGroup(mg) {
    const created = await get().api<MessagingGroupRecord>('/api/admin/messaging-groups', {
      method: 'POST',
      body: JSON.stringify(mg),
    });
    const record: MessagingGroupRecord = { ...created, wirings: created.wirings ?? [] };
    set((s) => ({ messagingGroups: [...s.messagingGroups, record] }));
    return record;
  },

  async deleteMessagingGroup(id) {
    await get().api(`/api/admin/messaging-groups/${id}`, { method: 'DELETE' });
    set((s) => ({ messagingGroups: s.messagingGroups.filter((mg) => mg.id !== id) }));
  },

  async updateMessagingGroup(id, patch) {
    await get().api(`/api/admin/messaging-groups/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    await get().loadMessagingGroups();
  },

  async addWiring(mgId, wiring) {
    await get().api(`/api/admin/messaging-groups/${mgId}/wirings`, {
      method: 'POST',
      body: JSON.stringify(wiring),
    });
    await get().loadMessagingGroups();
  },

  async updateWiring(mgId, groupId, agentId, patch) {
    await get().api(`/api/admin/messaging-groups/${mgId}/wirings/${groupId}/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    await get().loadMessagingGroups();
  },

  async removeWiring(mgId, groupId, agentId) {
    await get().api(`/api/admin/messaging-groups/${mgId}/wirings/${groupId}/${agentId}`, {
      method: 'DELETE',
    });
    set((s) => ({
      messagingGroups: s.messagingGroups.map((mg) =>
        mg.id !== mgId ? mg : { ...mg, wirings: mg.wirings.filter((w) => !(w.groupId === groupId && w.agentId === agentId)) },
      ),
    }));
  },

  async createPairing(input) {
    return get().api('/api/pairings', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  // ─── Admin: Groups (yaml + DB override) ──────────────────────────────────────
  async loadAdminGroups() {
    const groups = await get().api<AdminGroupRecord[]>('/api/admin/groups');
    set({ adminGroups: groups });
  },

  async patchAdminGroup(id, patch) {
    await get().api(`/api/admin/groups/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    await get().loadAdminGroups();
    // 同步刷新 chat 端 groups
    await get().loadGroups();
  },

  async resetAdminGroup(id) {
    await get().api(`/api/admin/groups/${id}/override`, { method: 'DELETE' });
    await get().loadAdminGroups();
    await get().loadGroups();
  },
}));

function handleWsMessage(
  msg: WsServerMessage,
  set: (fn: (s: State) => Partial<State>) => void,
  get: () => State,
): void {
  if (!('sessionId' in msg)) return;
  const sessionId = msg.sessionId;

  if (msg.type === 'agent.chunk' && msg.delta) {
    set((s) => {
      const list = [...(s.messages[sessionId] ?? [])];
      const last = list[list.length - 1];
      if (last && last.role === 'assistant' && last.id === '__streaming__') {
        list[list.length - 1] = { ...last, content: last.content + msg.delta };
      } else {
        list.push({
          id: '__streaming__',
          role: 'assistant',
          content: msg.delta,
        });
      }
      return { messages: { ...s.messages, [sessionId]: list } };
    });
  }

  if (msg.type === 'agent.toolCall') {
    set((s) => {
      const list = [...(s.messages[sessionId] ?? [])];
      // 找到正在串流的 assistant message 或建立新的
      let target = list.find(
        (m) => m.role === 'assistant' && m.id === '__streaming__',
      );
      if (!target) {
        target = { id: '__streaming__', role: 'assistant', content: '', toolCalls: [] };
        list.push(target);
      }
      const calls = [...(target.toolCalls ?? [])];
      calls.push({
        callId: msg.callId,
        tool: msg.tool,
        args: msg.args,
        status: 'running',
      });
      const idx = list.indexOf(target);
      list[idx] = { ...target, toolCalls: calls };
      return { messages: { ...s.messages, [sessionId]: list } };
    });
  }

  if (msg.type === 'agent.toolResult') {
    set((s) => {
      const list = [...(s.messages[sessionId] ?? [])];
      // 更新對應的 toolCall 狀態
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i]!;
        if (m.toolCalls?.some((tc) => tc.callId === msg.callId)) {
          const updatedCalls = m.toolCalls!.map((tc) =>
            tc.callId === msg.callId
              ? { ...tc, status: msg.status, result: msg.result }
              : tc,
          );
          list[i] = { ...m, toolCalls: updatedCalls };
          break;
        }
      }
      return { messages: { ...s.messages, [sessionId]: list } };
    });
  }

  if (msg.type === 'agent.subagentStarted') {
    set((s) => {
      const list = [...(s.messages[sessionId] ?? [])];
      list.push({
        id: `subagent-${msg.agentName}-${Date.now()}`,
        role: 'assistant',
        content: `🤖 子代理 **${msg.agentName}** 已啟動`,
      });
      return { messages: { ...s.messages, [sessionId]: list } };
    });
  }

  if (msg.type === 'agent.subagentCompleted') {
    set((s) => {
      const list = [...(s.messages[sessionId] ?? [])];
      list.push({
        id: `subagent-done-${msg.agentName}-${Date.now()}`,
        role: 'assistant',
        content: `✅ 子代理 **${msg.agentName}** 完成：${msg.summary}`,
      });
      return { messages: { ...s.messages, [sessionId]: list } };
    });
  }

  if (msg.type === 'agent.approvalRequired') {
    set((s) => ({
      pendingApprovals: [
        ...s.pendingApprovals,
        {
          requestId: msg.requestId,
          sessionId,
          tool: msg.tool,
          args: msg.args,
          description: msg.description,
        },
      ],
    }));
  }

  if (msg.type === 'agent.elicitationRequired') {
    set((s) => ({
      pendingElicitations: [
        ...s.pendingElicitations,
        {
          requestId: msg.requestId,
          sessionId,
          question: msg.question,
          options: msg.options,
        },
      ],
    }));
  }

  if (msg.type === 'session.agentSwitched') {
    set((s) => {
      const list = [...(s.messages[sessionId] ?? [])];
      list.push({
        id: `switch-${Date.now()}`,
        role: 'assistant',
        content: `🔄 代理已從 **${msg.previousAgent}** 切換至 **${msg.currentAgent}**`,
      });
      return { messages: { ...s.messages, [sessionId]: list } };
    });
  }

  if (msg.type === 'agent.done') {
    set((s) => {
      const list = [...(s.messages[sessionId] ?? [])];
      const last = list[list.length - 1];
      if (last && last.id === '__streaming__') {
        list[list.length - 1] = { ...last, id: msg.messageId ?? crypto.randomUUID() };
      }
      return { messages: { ...s.messages, [sessionId]: list }, streaming: false };
    });
  }

  if (msg.type === 'agent.error') {
    set((s) => ({
      messages: {
        ...s.messages,
        [sessionId]: [
          ...(s.messages[sessionId] ?? []),
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `⚠️ ${msg.error.message}`,
          },
        ],
      },
      streaming: false,
    }));
  }
  void get;
}
