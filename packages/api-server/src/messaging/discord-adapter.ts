/**
 * Discord Adapter — Interactions endpoint + Bot HTTP API
 *
 * 簽章驗證：Ed25519（X-Signature-Ed25519 + X-Signature-Timestamp）
 * 使用 Node.js crypto.verify 原生 Ed25519 支援（Node 18+）
 */

import { verify } from 'node:crypto';
import type { IncomingMessage, MessageTarget, OutgoingMessage } from '@zeroclaw/shared';
import type { MessagingAdapter, WebhookRequest, WebhookResponse } from './adapter.js';

interface DiscordAdapterOptions {
  botToken: string;
  publicKey: string;
  appId?: string;
  /** Bot's own user ID (for mention detection) */
  botId?: string;
  fetch?: typeof fetch;
}

export function createDiscordAdapter(opts: DiscordAdapterOptions): MessagingAdapter {
  const fetchFn = opts.fetch ?? fetch;
  const apiBase = 'https://discord.com/api/v10';
  const pubKeyBytes = Buffer.from(opts.publicKey, 'hex');

  return {
    platform: 'discord',
    supportsThreads: true,

    async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
      // Ed25519 簽章驗證
      const signature = req.headers['x-signature-ed25519'];
      const timestamp = req.headers['x-signature-timestamp'];
      if (typeof signature !== 'string' || typeof timestamp !== 'string') {
        return { status: 401, messages: [] };
      }

      const isValid = verifyEd25519(
        pubKeyBytes,
        Buffer.from(signature, 'hex'),
        Buffer.from(timestamp + req.rawBody.toString('utf-8')),
      );
      if (!isValid) {
        return { status: 401, messages: [] };
      }

      const body = req.body as DiscordInteraction;

      // PING → PONG
      if (body.type === 1) {
        return { status: 200, body: { type: 1 }, messages: [] };
      }

      // MESSAGE_CREATE (type 2 = APPLICATION_COMMAND, type 4 = MESSAGE_COMPONENT)
      // 也處理直接的 message events
      const messages: IncomingMessage[] = [];

      if (body.type === 2 && body.data) {
        // Application command — 取得 options 中的文字或 resolved message
        const text = extractCommandText(body);
        if (text) {
          messages.push({
            platform: 'discord',
            platformUserId: body.member?.user?.id ?? body.user?.id ?? '',
            platformChatId: body.channel_id ?? '',
            threadId: null,
            isGroup: body.guild_id != null,
            isMention: true,
            text,
            command: body.data.name,
            raw: body,
            receivedAt: new Date(),
          });
        }
        // 回應 interaction 確認（DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE）
        return {
          status: 200,
          body: { type: 5 },
          messages,
        };
      }

      // Gateway-style message 事件（若透過 bot 接收）
      if ('content' in body) {
        const msgBody = body as unknown as DiscordMessageEvent;
        if (msgBody.author && !msgBody.author.bot) {
          messages.push({
            platform: 'discord',
            platformUserId: msgBody.author.id,
            platformChatId: msgBody.channel_id ?? '',
            threadId: (msgBody as unknown as Record<string, unknown>)['thread'] != null
              ? String(msgBody.channel_id ?? '')
              : null,
            isGroup: msgBody.guild_id != null,
            isMention: opts.botId != null && Array.isArray(msgBody.mentions) && msgBody.mentions.some((m) => m.id === opts.botId),
            text: msgBody.content,
            replyToMessageId: msgBody.message_reference?.message_id,
            raw: msgBody,
            receivedAt: msgBody.timestamp
              ? new Date(msgBody.timestamp)
              : new Date(),
          });
        }
      }

      return { status: 200, messages };
    },

    async send(target: MessageTarget, message: OutgoingMessage): Promise<void> {
      const body = {
        content: message.text,
        message_reference: message.replyToMessageId
          ? { message_id: message.replyToMessageId }
          : undefined,
      };
      await fetchFn(`${apiBase}/channels/${target.chatId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bot ${opts.botToken}`,
        },
        body: JSON.stringify(body),
      });
    },
  };
}

function verifyEd25519(publicKey: Buffer, signature: Buffer, message: Buffer): boolean {
  try {
    return verify('Ed25519', message, { key: publicKey, format: 'der', type: 'raw' } as never, signature);
  } catch {
    // Node.js raw Ed25519 key — construct DER wrapper
    // Ed25519 public key DER prefix: 302a300506032b6570032100
    const derPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const derKey = Buffer.concat([derPrefix, publicKey]);
    try {
      return verify('Ed25519', message, { key: derKey, format: 'der', type: 'spki' } as never, signature);
    } catch {
      return false;
    }
  }
}

function extractCommandText(interaction: DiscordInteraction): string | undefined {
  if (!interaction.data?.options) {
    return interaction.data?.name;
  }
  // 取第一個 string option 作為訊息文字
  for (const opt of interaction.data.options) {
    if (opt.type === 3 && typeof opt.value === 'string') {
      return opt.value;
    }
  }
  return interaction.data.name;
}

// ── Discord Types (minimal) ──

interface DiscordInteraction {
  type: number; // 1=PING, 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT
  data?: {
    name: string;
    options?: Array<{ type: number; name: string; value: unknown }>;
  };
  member?: { user?: { id: string; username?: string } };
  user?: { id: string; username?: string };
  channel_id?: string;
  guild_id?: string;
  token?: string;
  id?: string;
}

interface DiscordMessageEvent {
  id: string;
  content: string;
  channel_id: string;
  guild_id?: string;
  author: { id: string; username: string; bot?: boolean };
  timestamp?: string;
  message_reference?: { message_id: string };
  mentions?: Array<{ id: string }>;
}
