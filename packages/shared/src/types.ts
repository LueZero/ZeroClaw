/**
 * 平台核心型別定義（與 SDK 無關）
 */

// ────────────────────────────────────────────────────────────────────
// SDK 與代理人
// ────────────────────────────────────────────────────────────────────

export type SdkType = 'opencode' | 'copilot';

export type AgentMode = 'primary' | 'subagent';

export interface AgentMetadata {
  /** 代理人 ID（資料夾名稱） */
  id: string;
  /** SDK 類型（依檔案指紋自動偵測） */
  sdk: SdkType;
  /** 顯示名稱 */
  displayName: string;
  /** Avatar / icon */
  avatar?: string;
  /** 描述 */
  description?: string;
  /** 此代理下可選的子代理 */
  subAgents: SubAgentInfo[];
  /** 預設子代理 */
  primaryAgent?: string;
  /** 是否有自訂 Dockerfile */
  hasCustomDockerfile: boolean;
}

export interface SubAgentInfo {
  name: string;
  displayName: string;
  description: string;
  mode: AgentMode;
  isDefault?: boolean;
}

// ────────────────────────────────────────────────────────────────────
// 群組配置
// ────────────────────────────────────────────────────────────────────

export type RoutingMode = 'explicit' | 'auto' | 'round-robin';

export type ChannelAccess = 'public' | 'authenticated' | `role:${string}`;

export type Platform = 'web' | 'telegram' | 'whatsapp' | 'discord' | 'slack' | 'teams';

export type SessionMode = 'per-user' | 'per-thread' | 'shared' | 'agent-shared';

export type EngageMode = 'pattern' | 'mention' | 'mention-sticky';

export type IgnoredMessagePolicy = 'drop' | 'accumulate';

export interface ContainerConfig {
  baseImage: string;
  maxSessions: number;
  env?: Record<string, string>;
  volumes?: string[];
  mountAgentsDir?: boolean;
  resources?: {
    cpus?: string;
    memory?: string;
  };
}

export interface RoutingConfig {
  mode: RoutingMode;
  fallback?: string;
  autoClassifierModel?: string;
}

export interface GroupConfig {
  id: string;
  displayName: string;
  description?: string;
  icon?: string;
  enabled: boolean;
  agents: string[];
  defaultAgent?: string;
  container: ContainerConfig;
  routing: RoutingConfig;
}

/**
 * Runtime override for a small subset of GroupConfig fields, stored in DB
 * (table `group_overrides`). NULL fields fall back to yaml.
 */
export interface GroupOverride {
  groupId: string;
  displayName?: string | null;
  description?: string | null;
  icon?: string | null;
  enabled?: boolean | null;
  /** Override defaultAgent (must be in agents[]). NULL = use yaml value. */
  defaultAgent?: string | null;
  /** Override container.maxSessions. NULL = use yaml value. */
  maxSessions?: number | null;
  /** Override routing.mode. NULL = use yaml value. */
  routingMode?: string | null;
  /** Override routing.fallback. NULL = clear / use yaml value. */
  routingFallback?: string | null;
  /** Override routing.autoClassifierModel. NULL = clear / use yaml value. */
  routingAutoClassifierModel?: string | null;
  updatedAt: Date;
}

// ────────────────────────────────────────────────────────────────────
// Messaging Groups（通訊平台動態路由）
// ────────────────────────────────────────────────────────────────────

export interface MessagingGroup {
  id: string;
  platform: Platform;
  platformChatId: string;
  isGroup: boolean;
  unknownSenderPolicy: 'allow' | 'drop';
  deniedAt?: string | null;
  createdAt: Date;
}

export interface MessagingGroupAgent {
  messagingGroupId: string;
  groupId: string;
  agentId: string;
  engageMode: EngageMode;
  engagePattern?: string | null;
  sessionMode: SessionMode;
  ignoredMessagePolicy: IgnoredMessagePolicy;
  createdAt: Date;
}

export interface MessagingGroupWithWirings extends MessagingGroup {
  wirings: MessagingGroupAgent[];
}

// ────────────────────────────────────────────────────────────────────
// 訊息（通訊平台正規化）
// ────────────────────────────────────────────────────────────────────

export interface Attachment {
  type: 'file' | 'image' | 'audio';
  name: string;
  mimeType?: string;
  url?: string;
  content?: string; // 文字內容直接帶入
  size?: number;
}

export interface IncomingMessage {
  platform: Platform;
  platformUserId: string;
  platformChatId: string;
  text: string;
  attachments?: Attachment[];
  mentionedAgent?: string;
  command?: string;
  replyToMessageId?: string;
  threadId?: string | null;
  isMention?: boolean;
  isGroup?: boolean;
  raw: unknown;
  receivedAt: Date;
}

export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'code'; language: string; content: string }
  | { type: 'image'; url: string; alt?: string }
  | { type: 'file'; name: string; url: string };

export interface OutgoingMessage {
  text: string;
  format: 'plain' | 'markdown';
  parts?: MessagePart[];
  replyToMessageId?: string;
}

export interface MessageTarget {
  platform: Platform;
  chatId: string;
  userId: string;
}

// ────────────────────────────────────────────────────────────────────
// Session
// ────────────────────────────────────────────────────────────────────

export type SessionStatus = 'pending' | 'active' | 'idle' | 'ended' | 'error' | 'expired';

export interface SessionRecord {
  sessionId: string;
  userId: string;
  groupId: string;
  agentId: string;
  subAgent?: string;
  containerId: string | null;
  sdkSessionId: string | null;
  platform: Platform;
  platformUserId?: string;
  platformChatId?: string | null;
  threadId?: string | null;
  messagingGroupId?: string | null;
  title?: string;
  status: SessionStatus;
  createdAt: Date;
  lastMessageAt: Date;
  messageCount: number;
}

// ────────────────────────────────────────────────────────────────────
// 容器
// ────────────────────────────────────────────────────────────────────

export type ContainerStatus = 'starting' | 'running' | 'unhealthy' | 'stopping' | 'stopped';

export interface ContainerInstance {
  containerId: string;
  groupId: string;
  agentId: string;
  imageTag: string;
  host: string;
  port: number;
  protocol: 'jsonrpc-tcp' | 'http';
  activeSdkSessions: number;
  maxSessions: number;
  status: ContainerStatus;
  createdAt: Date;
  lastActivityAt: Date;
}

// ────────────────────────────────────────────────────────────────────
// 認證 / 用戶
// ────────────────────────────────────────────────────────────────────

export type Role = 'admin' | 'member' | 'guest';

export interface User {
  id: string;
  role: Role;
  displayName: string;
  email?: string;
  externalIds: Record<Platform, string | undefined>;
  createdAt: Date;
}

export interface AuthContext {
  userId: string;
  role: Role;
}

// ────────────────────────────────────────────────────────────────────
// Token usage
// ────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalCostUsd?: number;
}

// ────────────────────────────────────────────────────────────────────
// 訊息（聊天記錄）
// ────────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  agentId?: string; // 助手訊息屬於哪個代理
  content: string;
  toolCalls?: ToolCallRecord[];
  usage?: TokenUsage;
  createdAt: Date;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  status: 'running' | 'completed' | 'error';
  startedAt: Date;
  endedAt?: Date;
}
