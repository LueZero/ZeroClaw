/**
 * AgentProvider — API Server 端與容器內 AgentRuntime 對話的抽象介面
 *
 * 兩個實作：
 *  - CopilotAgentProvider：JSON-RPC over TCP（@github/copilot-sdk 相容）
 *  - OpencodeAgentProvider：HTTP + SSE（@opencode-ai/sdk 相容）
 *
 * 重點：API Server 只與此介面對話，路由層 / 訊息層 / WS 層完全不關心 SDK 差異。
 */

import type {
  AgentEvent,
  Attachment,
  ChatMessage,
  IncomingMessage,
} from '@zeroclaw/shared';

export interface CreateSessionOptions {
  /** 平台 sessionId（platform 端產生） */
  sessionId: string;
  userId: string;
  /** agent 資料夾名稱 */
  agentId: string;
  /** 子代理（Opencode 為 .opencode/agents/<n>，Copilot 為 customAgents） */
  subAgent?: string;
}

export interface SessionHandle {
  /** SDK 端的 session id（與平台 sessionId 可能不同） */
  sdkSessionId: string;
  /** 平台 sessionId */
  sessionId: string;
}

export interface SendMessageOptions {
  text: string;
  attachments?: Attachment[];
  /** 中止訊號 */
  signal?: AbortSignal;
}

export interface AgentProvider {
  /** 容器是否已就緒 */
  isReady(): Promise<boolean>;

  /** 建立新 session */
  createSession(options: CreateSessionOptions): Promise<SessionHandle>;

  /** 取得已存在 session（不存在則建立） */
  ensureSession(options: CreateSessionOptions): Promise<SessionHandle>;

  /** 結束 session */
  closeSession(sdkSessionId: string): Promise<void>;

  /** 切換子代理（不重建 session） */
  switchAgent(sdkSessionId: string, subAgent: string): Promise<void>;

  /**
   * 發送訊息並串流接收 AgentEvent
   * （內部會處理 chunk → 完整訊息的累積）
   */
  sendMessage(
    sdkSessionId: string,
    options: SendMessageOptions,
  ): AsyncIterable<AgentEvent>;

  /** 中止當前回合 */
  abortTurn(sdkSessionId: string): Promise<void>;

  /** 回應 approval 請求 */
  resolveApproval(
    sdkSessionId: string,
    requestId: string,
    approved: boolean,
  ): Promise<void>;

  /** 回應 elicitation 請求 */
  resolveElicitation(
    sdkSessionId: string,
    requestId: string,
    answer: string,
  ): Promise<void>;

  /**
   * T-1: 注入歷史訊息到新建立的 SDK session（容器重啟/遷移後復活上下文）。
   * 實作方式因 SDK 而異：Opencode 透過 POST prompt 注入格式化歷史；Copilot 用 session.prompt RPC。
   * 若 provider 不支援或注入失敗，應靜默跳過（不阻斷新訊息）。
   */
  injectHistory?(sdkSessionId: string, messages: ChatMessage[]): Promise<void>;

  /** 釋放資源 */
  dispose(): Promise<void>;
}

export interface AgentProviderConnectionInfo {
  host: string;
  port: number;
  protocol: 'jsonrpc-tcp' | 'http';
}

/** 將 IncomingMessage 轉成 SendMessageOptions 的工具函式 */
export function incomingToSendOptions(msg: IncomingMessage): SendMessageOptions {
  return {
    text: msg.text,
    attachments: msg.attachments,
  };
}
