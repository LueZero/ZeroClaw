/**
 * Slack Events API Adapter
 *
 * URL 驗證：type=url_verification → 回傳 challenge
 * 簽章驗證：v0=HMAC-SHA256(v0:{timestamp}:{rawBody}) 對比 X-Slack-Signature，timestamp 5 分鐘內
 * 事件 dedup：以 event_id 追蹤（Slack 會 retry）
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, MessageTarget, OutgoingMessage } from '@zeroclaw/shared';
import type { MessagingAdapter, WebhookRequest, WebhookResponse } from './adapter.js';

interface SlackAdapterOptions {
  botToken: string;
  signingSecret: string;
  appId?: string;
  /** Bot user ID（避免回應自己的訊息） */
  botUserId?: string;
  fetch?: typeof fetch;
}

const FIVE_MINUTES_SEC = 5 * 60;
const SEEN_EVENTS_MAX = 10_000;

export function createSlackAdapter(opts: SlackAdapterOptions): MessagingAdapter {
  const fetchFn = opts.fetch ?? fetch;
  const apiBase = 'https://slack.com/api';
  const seenEvents = new Set<string>();

  return {
    platform: 'slack',
    supportsThreads: true,

    async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
      const body = req.body as SlackPayload;

      // URL verification（註冊 webhook 時 Slack 發送）
      if (body.type === 'url_verification') {
        return { status: 200, body: { challenge: body.challenge }, messages: [] };
      }

      // 簽章驗證
      if (!verifySlackSignature(req, opts.signingSecret)) {
        return { status: 401, messages: [] };
      }

      if (body.type !== 'event_callback' || !body.event) {
        return { status: 200, messages: [] };
      }

      // 事件 dedup
      if (body.event_id) {
        if (seenEvents.has(body.event_id)) {
          return { status: 200, messages: [] };
        }
        seenEvents.add(body.event_id);
        // 防止 Set 無限增長
        if (seenEvents.size > SEEN_EVENTS_MAX) {
          const first = seenEvents.values().next().value;
          if (first) seenEvents.delete(first);
        }
      }

      const event = body.event;
      const messages: IncomingMessage[] = [];

      // 只處理 message 類型，跳過 bot 訊息和 subtypes（edited / deleted 等）
      if (
        event.type === 'message' &&
        !event.subtype &&
        event.text &&
        event.user &&
        event.user !== opts.botUserId
      ) {
        // 偵測 @mention agent
        let mentionedAgent: string | undefined;
        const mentionMatch = event.text.match(/<@(\w+)>/);
        if (mentionMatch) {
          // Slack mention 格式 <@U1234>，這裡存 raw ID
          mentionedAgent = undefined; // 需要外層 mapping
        }

        messages.push({
          platform: 'slack',
          platformUserId: event.user,
          platformChatId: event.channel,
          threadId: event.thread_ts ?? null,
          isGroup: event.channel_type !== 'im',
          isMention: opts.botUserId != null && event.text.includes(`<@${opts.botUserId}>`),
          text: cleanSlackText(event.text),
          replyToMessageId: event.thread_ts,
          raw: body,
          receivedAt: event.ts
            ? new Date(parseFloat(event.ts) * 1000)
            : new Date(),
        });
      }

      return { status: 200, messages };
    },

    async send(target: MessageTarget, message: OutgoingMessage): Promise<void> {
      const body: Record<string, unknown> = {
        channel: target.chatId,
        text: message.text,
        // 若有 replyToMessageId，使用 thread_ts 回覆在同一 thread
        ...(message.replyToMessageId ? { thread_ts: message.replyToMessageId } : {}),
      };

      // 支援 markdown → Slack mrkdwn
      if (message.format === 'markdown') {
        body.mrkdwn = true;
      }

      await fetchFn(`${apiBase}/chat.postMessage`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${opts.botToken}`,
        },
        body: JSON.stringify(body),
      });
    },
  };
}

function verifySlackSignature(req: WebhookRequest, signingSecret: string): boolean {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];

  if (typeof timestamp !== 'string' || typeof signature !== 'string') return false;

  // 防止 replay：timestamp 必須在 5 分鐘內
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > FIVE_MINUTES_SEC) return false;

  const baseString = `v0:${timestamp}:${req.rawBody.toString('utf-8')}`;
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(baseString).digest('hex');

  const expectedBuf = Buffer.from(expected);
  const gotBuf = Buffer.from(signature);
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}

/** 清理 Slack 格式文字：移除 user/channel mention 標記 */
function cleanSlackText(text: string): string {
  return text
    .replace(/<@\w+>/g, '') // 移除 @mention
    .replace(/<#\w+\|(\w+)>/g, '#$1') // channel mention → #name
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2') // URL label
    .replace(/<(https?:\/\/[^>]+)>/g, '$1') // bare URL
    .trim();
}

// ── Slack Types (minimal) ──

interface SlackPayload {
  type: string; // 'url_verification' | 'event_callback'
  challenge?: string;
  token?: string;
  event_id?: string;
  event?: SlackEvent;
}

interface SlackEvent {
  type: string; // 'message' | 'app_mention' | ...
  subtype?: string; // 'message_changed', 'message_deleted', ...
  user?: string;
  text?: string;
  channel: string;
  channel_type?: 'channel' | 'group' | 'im' | 'mpim';
  ts?: string;
  thread_ts?: string;
}
