/**
 * Telegram Adapter — Bot API（不依賴第三方 SDK）
 *
 * 兩種模式（與 nanoclaw 的 `@chat-adapter/telegram` 行為對齊）：
 *
 *   • polling（預設）：adapter.start() 啟動 long-polling getUpdates 迴圈，
 *     對外不需要公開 URL，使用者只要填 `TELEGRAM_BOT_TOKEN` 即可運作。
 *     啟動時會主動呼叫 deleteWebhook，避免與 webhook 衝突。
 *
 *   • webhook：保留原本路徑（POST /webhooks/telegram），由 SREs 自行
 *     `setWebhook` 後使用，適合公開部署環境。
 *
 * 切換以建構參數 `mode` 決定（預設 'polling'）；env 名稱對應 `TELEGRAM_MODE`。
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, MessageTarget, OutgoingMessage } from '@zeroclaw/shared';
import type {
  MessagingAdapter,
  MessagingAdapterRuntime,
  WebhookRequest,
  WebhookResponse,
} from './adapter.js';

interface TelegramAdapterOptions {
  botToken: string;
  webhookSecret?: string;
  /** 'polling' | 'webhook'，預設 'polling' */
  mode?: 'polling' | 'webhook';
  /** long-poll timeout（秒），預設 25 */
  pollTimeoutSec?: number;
  fetch?: typeof fetch;
}

export function createTelegramAdapter(opts: TelegramAdapterOptions): MessagingAdapter {
  const fetchFn = opts.fetch ?? fetch;
  const apiBase = `https://api.telegram.org/bot${opts.botToken}`;
  const mode = opts.mode ?? 'polling';
  const pollTimeoutSec = opts.pollTimeoutSec ?? 25;

  let botUsername = '';

  const pollState = {
    running: false,
    abort: null as AbortController | null,
    offset: 0,
  };

  function parseUpdate(update: TgUpdate): IncomingMessage | null {
    const msg = update.message ?? update.edited_message;
    if (!msg || !msg.text) return null;
    const isGroup = msg.chat.type !== 'private';
    const isMention = botUsername
      ? msg.text.includes('@' + botUsername)
      : isGroup; // fallback: treat all group msgs as mention if we don't know the username
    return {
      platform: 'telegram',
      platformUserId: String(msg.from?.id ?? ''),
      platformChatId: String(msg.chat.id),
      threadId: null,
      isGroup,
      isMention: isMention || !isGroup, // DMs are always "mentions"
      text: msg.text,
      command: msg.text.startsWith('/') ? msg.text.split(/\s+/)[0]!.slice(1) : undefined,
      replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      raw: update,
      receivedAt: new Date((msg.date ?? Date.now() / 1000) * 1000),
    };
  }

  return {
    platform: 'telegram',
    supportsThreads: false,

    async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
      if (opts.webhookSecret) {
        const got = req.headers['x-telegram-bot-api-secret-token'];
        if (typeof got !== 'string' || !safeEqual(got, opts.webhookSecret)) {
          return { status: 401, messages: [] };
        }
      }
      const incoming = parseUpdate(req.body as TgUpdate);
      return { status: 200, messages: incoming ? [incoming] : [] };
    },

    async send(target: MessageTarget, message: OutgoingMessage): Promise<void> {
      // Telegram MarkdownV2 規則極嚴（_*[]()~`>#+-=|{}.! 全要 \ escape），未跳脫即被退 400
      // 預設用 plain text；若呼叫端顯式要求 markdown，先嘗試 MarkdownV2，失敗自動退 plain
      const tryParseModes: Array<string | undefined> =
        message.format === 'markdown' ? ['MarkdownV2', undefined] : [undefined];
      for (const parseMode of tryParseModes) {
        const body = {
          chat_id: target.chatId,
          text: message.text,
          parse_mode: parseMode,
          reply_to_message_id: message.replyToMessageId
            ? Number(message.replyToMessageId)
            : undefined,
        };
        const res = await fetchFn(`${apiBase}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) return;
        const errBody = await res.text();
        // 400 通常是 parse_mode 失敗；繼續嘗試下一個 parseMode
        if (res.status !== 400 || parseMode === undefined) {
          throw new Error(
            `Telegram sendMessage failed: ${res.status} ${errBody}`,
          );
        }
        // 否則 fallthrough 至 plain
      }
    },

    async start(runtime: MessagingAdapterRuntime): Promise<void> {
      if (mode !== 'polling') {
        runtime.logger.info('Telegram running in webhook mode (start() skipped)');
        return;
      }
      if (pollState.running) return;
      pollState.running = true;
      pollState.abort = new AbortController();

      // 啟動前先取得 bot 名稱（用於 mention 判斷）
      try {
        const r = await fetchFn(`${apiBase}/getMe`);
        const j = (await r.json()) as { ok: boolean; result?: { username?: string } };
        if (j.ok && j.result?.username) botUsername = j.result.username;
      } catch (err) {
        runtime.logger.warn({ err }, 'Telegram getMe failed — mention detection may be inaccurate');
      }

      // 啟動前刪除可能殘留的 webhook，避免 getUpdates 被 Telegram 拒絕
      try {
        const res = await fetchFn(`${apiBase}/deleteWebhook?drop_pending_updates=false`, {
          method: 'POST',
        });
        const json = (await res.json()) as { ok: boolean; description?: string };
        if (!json.ok) {
          runtime.logger.warn({ description: json.description }, 'Telegram deleteWebhook failed');
        }
      } catch (err) {
        runtime.logger.warn({ err }, 'Telegram deleteWebhook errored');
      }

      runtime.logger.info('Telegram polling started');

      void (async () => {
        while (pollState.running) {
          try {
            const url =
              `${apiBase}/getUpdates?timeout=${pollTimeoutSec}` +
              `&offset=${pollState.offset}&allowed_updates=${encodeURIComponent(
                JSON.stringify(['message', 'edited_message']),
              )}`;
            const res = await fetchFn(url, { signal: pollState.abort?.signal });
            if (!res.ok) {
              runtime.logger.warn({ status: res.status }, 'getUpdates HTTP error');
              await delay(2000);
              continue;
            }
            const json = (await res.json()) as { ok: boolean; result: TgUpdate[] };
            if (!json.ok) {
              await delay(2000);
              continue;
            }
            const messages: IncomingMessage[] = [];
            for (const update of json.result) {
              if (update.update_id >= pollState.offset) {
                pollState.offset = update.update_id + 1;
              }
              const parsed = parseUpdate(update);
              if (parsed) messages.push(parsed);
            }
            if (messages.length > 0) {
              await runtime.onMessages(messages);
            }
          } catch (err) {
            if ((err as { name?: string })?.name === 'AbortError') break;
            runtime.logger.error({ err }, 'Telegram polling loop error');
            await delay(2000);
          }
        }
        runtime.logger.info('Telegram polling stopped');
      })();
    },

    async stop(): Promise<void> {
      if (!pollState.running) return;
      pollState.running = false;
      pollState.abort?.abort();
      pollState.abort = null;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// ── Telegram Bot API 型別（最小集合） ──
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}
interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
  date?: number;
  text?: string;
  reply_to_message?: { message_id: number };
}
