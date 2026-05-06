/**
 * WhatsApp Cloud API Adapter
 *
 * Webhook 驗證：GET hub.mode=subscribe + hub.verify_token + hub.challenge
 * 簽章檢查：HMAC-SHA256 - X-Hub-Signature-256 header
 * 發送：Graph API POST /{phone_number_id}/messages
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, MessageTarget, OutgoingMessage } from '@zeroclaw/shared';
import type { MessagingAdapter, WebhookRequest, WebhookResponse } from './adapter.js';

interface WhatsAppAdapterOptions {
  accessToken: string;
  verifyToken: string;
  phoneNumberId?: string;
  appSecret?: string; // 用於 X-Hub-Signature-256 驗章
  fetch?: typeof fetch;
}

export function createWhatsAppAdapter(opts: WhatsAppAdapterOptions): MessagingAdapter {
  const fetchFn = opts.fetch ?? fetch;
  const graphBase = 'https://graph.facebook.com/v21.0';

  return {
    platform: 'whatsapp',
    supportsThreads: false,

    verifyWebhook(req: WebhookRequest): WebhookResponse {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && token === opts.verifyToken) {
        return { status: 200, body: challenge, messages: [] };
      }
      return { status: 403, body: 'Forbidden', messages: [] };
    },

    async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
      // 驗簽（若提供 appSecret）
      if (opts.appSecret) {
        const sig = req.headers['x-hub-signature-256'];
        if (typeof sig !== 'string' || !verifyHmac(req.rawBody, opts.appSecret, sig)) {
          return { status: 401, messages: [] };
        }
      }

      const payload = req.body as WaWebhookPayload;
      if (payload.object !== 'whatsapp_business_account') {
        return { status: 200, messages: [] };
      }

      const messages: IncomingMessage[] = [];

      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          if (change.field !== 'messages') continue;
          const value = change.value;
          if (!value?.messages) continue;

          const contactMap = new Map<string, WaContact>();
          for (const c of value.contacts ?? []) {
            contactMap.set(c.wa_id, c);
          }

          for (const msg of value.messages) {
            if (msg.type !== 'text' || !msg.text?.body) continue;

            const contact = contactMap.get(msg.from);
            messages.push({
              platform: 'whatsapp',
              platformUserId: msg.from,
              platformChatId: value.metadata?.phone_number_id ?? opts.phoneNumberId ?? '',
              threadId: null,
              isGroup: false,
              isMention: true,
              text: msg.text.body,
              replyToMessageId: msg.context?.message_id,
              raw: payload,
              receivedAt: new Date(parseInt(msg.timestamp, 10) * 1000),
            });
          }
        }
      }

      return { status: 200, messages };
    },

    async send(target: MessageTarget, message: OutgoingMessage): Promise<void> {
      const phoneNumberId = target.chatId || opts.phoneNumberId;
      const body = {
        messaging_product: 'whatsapp',
        to: target.userId,
        type: 'text',
        text: { body: message.text },
      };
      await fetchFn(`${graphBase}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.accessToken}`,
        },
        body: JSON.stringify(body),
      });
    },
  };
}

function verifyHmac(rawBody: Buffer, secret: string, signature: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const gotBuf = Buffer.from(signature);
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}

// ── WhatsApp Cloud API Types ──

interface WaWebhookPayload {
  object: string;
  entry?: WaEntry[];
}

interface WaEntry {
  id: string;
  changes?: WaChange[];
}

interface WaChange {
  field: string;
  value: WaChangeValue;
}

interface WaChangeValue {
  messaging_product?: string;
  metadata?: { phone_number_id: string; display_phone_number: string };
  contacts?: WaContact[];
  messages?: WaMessage[];
}

interface WaContact {
  wa_id: string;
  profile?: { name: string };
}

interface WaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  context?: { message_id: string };
}
