/**
 * Discord Adapter — Interactions endpoint + Gateway WebSocket + Bot HTTP API
 *
 * Webhook 模式：Ed25519 簽章驗證（X-Signature-Ed25519 + X-Signature-Timestamp）
 * Gateway 模式：WSS wss://gateway.discord.gg/?v=10&encoding=json（T-32）
 *   - 免公開 URL，與 Telegram polling 體驗一致
 *   - DISCORD_MODE=gateway|webhook 控制
 */

import { verify } from 'node:crypto';
import type { IncomingMessage, MessageTarget, OutgoingMessage } from '@zeroclaw/shared';
import type { MessagingAdapter, MessagingAdapterRuntime, WebhookRequest, WebhookResponse } from './adapter.js';

interface DiscordAdapterOptions {
  botToken: string;
  publicKey: string;
  appId?: string;
  /** Bot's own user ID (for mention detection) */
  botId?: string;
  /** gateway | webhook (default: webhook) */
  mode?: 'gateway' | 'webhook';
  fetch?: typeof fetch;
}

export function createDiscordAdapter(opts: DiscordAdapterOptions): MessagingAdapter {
  const fetchFn = opts.fetch ?? fetch;
  const apiBase = 'https://discord.com/api/v10';
  const pubKeyBytes = Buffer.from(opts.publicKey, 'hex');
  const mode = opts.mode ?? 'webhook';

  // ── Gateway state ──
  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastSequence: number | null = null;
  let sessionId: string | null = null;
  let resumeGatewayUrl: string | null = null;
  let gatewayRuntime: MessagingAdapterRuntime | null = null;
  let selfBotId: string | null = opts.botId ?? null;
  let stopped = false;
  let reconnectAttempts = 0;

  /** Parse MESSAGE_CREATE dispatch into IncomingMessage */
  function parseMessageCreate(d: DiscordMessageEvent): IncomingMessage | null {
    if (!d.author || d.author.bot) return null;
    if (!d.content || !d.content.trim()) return null;

    const isThread = d.thread != null || (d.message_reference != null);
    return {
      platform: 'discord',
      platformUserId: d.author.id,
      platformChatId: d.channel_id ?? '',
      threadId: isThread ? d.channel_id : null,
      isGroup: d.guild_id != null,
      isMention: selfBotId != null && Array.isArray(d.mentions) && d.mentions.some((m) => m.id === selfBotId),
      text: d.content,
      replyToMessageId: d.message_reference?.message_id,
      raw: d,
      receivedAt: d.timestamp ? new Date(d.timestamp) : new Date(),
    };
  }

  /** Connect to Discord Gateway WSS */
  function connectGateway(url?: string): void {
    if (stopped) return;
    const gatewayUrl = url ?? 'wss://gateway.discord.gg/?v=10&encoding=json';
    const logger = gatewayRuntime?.logger;
    logger?.info({ url: gatewayUrl }, 'Connecting to Discord Gateway');

    ws = new WebSocket(gatewayUrl);

    ws.addEventListener('open', () => {
      logger?.info('Discord Gateway WebSocket opened');
    });

    ws.addEventListener('message', (event) => {
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(String(event.data)) as GatewayPayload;
      } catch {
        logger?.warn('Failed to parse Gateway payload');
        return;
      }

      if (payload.s != null) lastSequence = payload.s;

      switch (payload.op) {
        case 10: { // HELLO
          const heartbeatInterval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
          startHeartbeat(heartbeatInterval);
          // If we have a session, try RESUME; otherwise IDENTIFY
          if (sessionId && lastSequence != null) {
            sendResume();
          } else {
            sendIdentify();
          }
          break;
        }
        case 11: // HEARTBEAT_ACK
          break;
        case 1: // HEARTBEAT request from server
          sendHeartbeat();
          break;
        case 0: // DISPATCH
          handleDispatch(payload.t!, payload.d);
          break;
        case 7: // RECONNECT
          logger?.info('Gateway requested reconnect');
          reconnect();
          break;
        case 9: { // INVALID_SESSION
          const resumable = payload.d as boolean;
          logger?.warn({ resumable }, 'Gateway invalid session');
          if (!resumable) {
            sessionId = null;
            lastSequence = null;
          }
          // Wait 1-5s then reconnect
          const delay = 1000 + Math.random() * 4000;
          setTimeout(() => reconnect(), delay);
          break;
        }
        default:
          logger?.debug({ op: payload.op }, 'Unhandled Gateway opcode');
      }
    });

    ws.addEventListener('close', (event) => {
      logger?.warn({ code: event.code, reason: event.reason }, 'Discord Gateway closed');
      stopHeartbeat();
      if (!stopped) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 60_000);
        reconnectAttempts++;
        logger?.info({ delay, attempt: reconnectAttempts }, 'Scheduling Gateway reconnect');
        setTimeout(() => reconnect(), delay);
      }
    });

    ws.addEventListener('error', (event) => {
      logger?.error({ error: event }, 'Discord Gateway error');
    });
  }

  function sendIdentify(): void {
    ws?.send(JSON.stringify({
      op: 2, // IDENTIFY
      d: {
        token: opts.botToken,
        intents: GATEWAY_INTENTS,
        properties: {
          os: process.platform,
          browser: 'zeroclaw',
          device: 'zeroclaw',
        },
      },
    }));
  }

  function sendResume(): void {
    ws?.send(JSON.stringify({
      op: 6, // RESUME
      d: {
        token: opts.botToken,
        session_id: sessionId,
        seq: lastSequence,
      },
    }));
  }

  function sendHeartbeat(): void {
    ws?.send(JSON.stringify({ op: 1, d: lastSequence }));
  }

  function startHeartbeat(intervalMs: number): void {
    stopHeartbeat();
    // First heartbeat after jitter
    const jitter = Math.random() * intervalMs;
    setTimeout(() => {
      sendHeartbeat();
      heartbeatTimer = setInterval(sendHeartbeat, intervalMs);
    }, jitter);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function reconnect(): void {
    if (stopped) return;
    try { ws?.close(); } catch { /* ignore */ }
    ws = null;
    stopHeartbeat();
    connectGateway(resumeGatewayUrl ?? undefined);
  }

  function handleDispatch(eventName: string, data: unknown): void {
    const logger = gatewayRuntime?.logger;

    switch (eventName) {
      case 'READY': {
        const ready = data as { session_id: string; resume_gateway_url: string; user: { id: string } };
        sessionId = ready.session_id;
        resumeGatewayUrl = ready.resume_gateway_url;
        selfBotId = ready.user.id;
        reconnectAttempts = 0;
        logger?.info({ sessionId, botId: selfBotId }, 'Discord Gateway READY');
        break;
      }
      case 'RESUMED':
        reconnectAttempts = 0;
        logger?.info('Discord Gateway RESUMED');
        break;
      case 'MESSAGE_CREATE': {
        const msg = parseMessageCreate(data as DiscordMessageEvent);
        if (msg && gatewayRuntime) {
          void gatewayRuntime.onMessages([msg]);
        }
        break;
      }
      default:
        // Ignore other events (GUILD_CREATE, PRESENCE_UPDATE, etc.)
        break;
    }
  }

  // Gateway intents: GUILDS (1) | GUILD_MESSAGES (512) | DIRECT_MESSAGES (4096) | MESSAGE_CONTENT (32768)
  const GATEWAY_INTENTS = 1 | (1 << 9) | (1 << 12) | (1 << 15);

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

    // ── Gateway mode: start / stop ──

    async start(runtime: MessagingAdapterRuntime): Promise<void> {
      if (mode !== 'gateway') return;
      gatewayRuntime = runtime;
      stopped = false;
      reconnectAttempts = 0;
      connectGateway();
    },

    async stop(): Promise<void> {
      stopped = true;
      stopHeartbeat();
      if (ws) {
        try { ws.close(1000, 'shutdown'); } catch { /* ignore */ }
        ws = null;
      }
    },

    // ── openDM: 主動開啟 DM 頻道 ──
    async openDM(userHandle: string): Promise<string> {
      const res = await fetchFn(`${apiBase}/users/@me/channels`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bot ${opts.botToken}`,
        },
        body: JSON.stringify({ recipient_id: userHandle }),
      });
      if (!res.ok) {
        throw new Error(`Discord openDM failed: ${res.status} ${await res.text()}`);
      }
      const channel = (await res.json()) as { id: string };
      return channel.id;
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

interface GatewayPayload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

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
  thread?: { id: string };
}
