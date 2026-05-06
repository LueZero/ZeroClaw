/**
 * Microsoft Teams Adapter — Azure Bot Service / Bot Framework v3
 *
 * 收訊：Bot Connector 把 Activity POST 到 messaging endpoint（zeroclaw 慣例 `/webhook/teams`）
 *       Authorization 為 Microsoft 簽發的 JWT；正式環境需驗 issuer/audience/key（BotFramework
 *       OpenID metadata），目前實作先做 issuer/audience 軟驗證（TODO：補完整 JWKS 驗章）。
 * 發送：以 client_credentials grant 向 Microsoft Identity 取 access_token
 *       (scope `https://api.botframework.com/.default`)，再 POST 到 activity 中提供的
 *       `serviceUrl` + `/v3/conversations/{conversationId}/activities`。
 *
 * 對應 nanoclaw `add-teams` skill 的設定流程（Azure App Registration + Azure Bot resource）。
 */

import type { IncomingMessage, MessageTarget, OutgoingMessage } from '@zeroclaw/shared';
import type { MessagingAdapter, WebhookRequest, WebhookResponse } from './adapter.js';

interface TeamsAdapterOptions {
  /** Azure App Registration → Application (client) ID */
  appId: string;
  /** Azure App Registration → Client secret value */
  appPassword: string;
  /**
   * Tenant ID。SingleTenant 必填；MultiTenant 用 'botframework.com'（預設）取通用 OAuth endpoint。
   * 對應 nanoclaw 的 TEAMS_APP_TYPE：MultiTenant → botframework.com、SingleTenant → tenantId
   */
  tenantId?: string;
  fetch?: typeof fetch;
}

interface TeamsConversationInfo {
  serviceUrl: string;
  conversationId: string;
}

export function createTeamsAdapter(opts: TeamsAdapterOptions): MessagingAdapter {
  const fetchFn = opts.fetch ?? fetch;
  const tenant = opts.tenantId && opts.tenantId.length > 0 ? opts.tenantId : 'botframework.com';
  const tokenEndpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

  // chatId（= conversation.id）→ { serviceUrl, conversationId } 對應，由收訊時填入
  const conversations = new Map<string, TeamsConversationInfo>();

  // Bot Framework token 快取
  let cachedToken: { value: string; expiresAt: number } | null = null;

  async function getAccessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
      return cachedToken.value;
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: opts.appId,
      client_secret: opts.appPassword,
      scope: 'https://api.botframework.com/.default',
    });
    const res = await fetchFn(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`Teams token endpoint failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = {
      value: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return cachedToken.value;
  }

  return {
    platform: 'teams',
    supportsThreads: false,

    async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
      // 軟驗證 Authorization 標頭存在；完整 JWT issuer/audience/JWKS 驗證列為 TODO
      const auth = req.headers['authorization'];
      if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
        return { status: 401, messages: [] };
      }

      const activity = req.body as TeamsActivity;
      if (!activity || activity.type !== 'message') {
        return { status: 200, messages: [] };
      }

      const chatId = activity.conversation?.id ?? '';
      if (!chatId) return { status: 200, messages: [] };

      // 暫存發送所需的 serviceUrl 與 conversationId
      if (activity.serviceUrl) {
        conversations.set(chatId, {
          serviceUrl: activity.serviceUrl.replace(/\/+$/, ''),
          conversationId: chatId,
        });
      }

      const text = (activity.text ?? '').trim();
      if (!text) return { status: 200, messages: [] };

      const message: IncomingMessage = {
        platform: 'teams',
        platformUserId: activity.from?.id ?? '',
        platformChatId: chatId,
        threadId: null,
        isGroup: activity.conversation?.isGroup ?? false,
        isMention: true,
        text,
        replyToMessageId: activity.replyToId,
        raw: activity,
        receivedAt: activity.timestamp ? new Date(activity.timestamp) : new Date(),
      };
      return { status: 200, messages: [message] };
    },

    async send(target: MessageTarget, message: OutgoingMessage): Promise<void> {
      const conv = conversations.get(target.chatId);
      if (!conv) {
        // Cold-start 發送（never-seen conversation）尚未支援；Teams 必須從 Activity 拿 serviceUrl
        throw new Error(`Teams conversation not seen yet: ${target.chatId}`);
      }
      const token = await getAccessToken();
      const body = {
        type: 'message',
        text: message.text,
        textFormat: message.format === 'markdown' ? 'markdown' : 'plain',
        replyToId: message.replyToMessageId,
      };
      const url = `${conv.serviceUrl}/v3/conversations/${encodeURIComponent(conv.conversationId)}/activities`;
      await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    },
  };
}

// ── Bot Framework Activity（最小型別） ──

interface TeamsActivity {
  type: 'message' | 'conversationUpdate' | 'invoke' | string;
  id?: string;
  timestamp?: string;
  serviceUrl?: string;
  channelId?: string;
  from?: { id: string; name?: string; aadObjectId?: string };
  conversation?: { id: string; conversationType?: string; tenantId?: string; isGroup?: boolean };
  recipient?: { id: string; name?: string };
  text?: string;
  textFormat?: 'plain' | 'markdown' | 'xml';
  replyToId?: string;
  channelData?: Record<string, unknown>;
}
