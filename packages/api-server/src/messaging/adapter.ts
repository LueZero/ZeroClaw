/**
 * MessagingAdapter — 各通訊平台的統一介面
 *
 * 每個 Adapter 負責：
 *  1. 將 webhook payload 解析為 IncomingMessage（webhook 模式）
 *  2. 主動拉訊息／維持長連線並透過 runtime.onMessages 推送（polling / gateway 模式）
 *  3. 將 OutgoingMessage 發送到平台
 *  4. 驗證 webhook 簽章
 */

import type { Logger } from 'pino';
import type { IncomingMessage, OutgoingMessage, MessageTarget, Platform } from '@zeroclaw/shared';

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  body: unknown;
  query: Record<string, string | undefined>;
}

export interface WebhookResponse {
  status: number;
  body?: unknown;
  /** 解析出的訊息（若為訊息事件） */
  messages: IncomingMessage[];
}

/** 啟動主動連線（polling / WebSocket gateway）時，adapter 收到的 runtime 工具 */
export interface MessagingAdapterRuntime {
  /** Adapter 收到訊息後呼叫此回呼，路由到 SessionManager */
  onMessages: (messages: IncomingMessage[]) => Promise<void>;
  logger: Logger;
}

export interface MessagingAdapter {
  readonly platform: Platform;
  /** 是否支援 thread 層級的會話隔離 */
  readonly supportsThreads: boolean;
  /** GET /webhook 驗證（如 WhatsApp/Telegram 使用） */
  verifyWebhook?(req: WebhookRequest): WebhookResponse;
  /** POST /webhook 接收訊息（webhook 模式） */
  handleWebhook(req: WebhookRequest): Promise<WebhookResponse>;
  /** 發送訊息到平台 */
  send(target: MessageTarget, message: OutgoingMessage): Promise<void>;
  /**
   * 啟動主動連線（polling / gateway）。
   * webhook 模式 adapter 可省略此方法。
   */
  start?(runtime: MessagingAdapterRuntime): Promise<void>;
  /** 停止主動連線（shutdown 時呼叫） */
  stop?(): Promise<void>;
  /** 開啟 DM 頻道並回傳 chatId（選用，Discord/Slack 適用） */
  openDM?(userHandle: string): Promise<string>;
}

export interface MessagingRegistry {
  get(platform: Platform): MessagingAdapter | undefined;
  list(): MessagingAdapter[];
  register(adapter: MessagingAdapter): void;
}

export function createMessagingRegistry(): MessagingRegistry {
  const map = new Map<Platform, MessagingAdapter>();
  return {
    get: (p) => map.get(p),
    list: () => Array.from(map.values()),
    register: (a) => map.set(a.platform, a),
  };
}
