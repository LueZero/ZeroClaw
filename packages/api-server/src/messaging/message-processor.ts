/**
 * message-processor v0.3
 *
 * Routing flow (based on nanoclaw router.ts):
 *   1. Pairing code short-circuit
 *   2. Reserved commands (/agents, /agent <id>)
 *   3. Thread policy (non-supportsThreads adapter -> threadId = null)
 *   4. MessagingGroup lookup; auto-create on first @mention
 *   5. Get wirings (messaging_group_agents)
 *   6. Fan-out: evaluateEngage for each wiring
 *   7. ignoredMessagePolicy === 'accumulate' -> silent store
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { IncomingMessage, MessagingGroupAgent } from '@zeroclaw/shared';
import type { MessagingAdapter } from './adapter.js';
import type { PairingService } from './pairing.js';
import type { AuthService } from '../auth/auth-service.js';
import type { GroupsRegistry } from '../config/groups-loader.js';
import type { SessionManager } from '../session/session-manager.js';
import type { DbStore } from '../db/db-store.js';

export interface MessageProcessorDeps {
  logger: Logger;
  auth: AuthService;
  groups: GroupsRegistry;
  sessions: SessionManager;
  db: DbStore;
  pairing: PairingService;
}

export async function processIncomingMessages(
  deps: MessageProcessorDeps,
  adapter: MessagingAdapter,
  messages: IncomingMessage[],
): Promise<void> {
  for (const incoming of messages) {
    await routeInbound(deps, adapter, incoming);
  }
}

async function routeInbound(
  deps: MessageProcessorDeps,
  adapter: MessagingAdapter,
  incoming: IncomingMessage,
): Promise<void> {
  const { logger, db, auth, groups, sessions, pairing } = deps;

  // 1. Pairing code short-circuit
  const pair = await pairing.tryConsume({
    text: incoming.text,
    platform: incoming.platform,
    chatId: incoming.platformChatId,
  });
  if (pair.matched) {
    try {
      await adapter.send(
        { platform: incoming.platform, chatId: incoming.platformChatId, userId: incoming.platformUserId },
        { text: `Paired to group "${pair.groupId}". Agent will handle future messages.`, format: 'plain' },
      );
    } catch (err) {
      logger.warn({ err }, 'pairing confirmation send failed');
    }
    return;
  }

  // 2. Thread policy
  const effectiveThreadId = adapter.supportsThreads ? (incoming.threadId ?? null) : null;
  const isMention = incoming.isMention === true;

  // 3. MessagingGroup lookup (auto-create on @mention; auto-seed default wiring)
  let mg = await db.getMessagingGroup(incoming.platform, incoming.platformChatId);
  if (!mg) {
    if (!isMention) return;
    const newMg = {
      id: `mg-${Date.now()}-${randomUUID().slice(0, 8)}`,
      platform: incoming.platform,
      platformChatId: incoming.platformChatId,
      isGroup: incoming.isGroup === true,
      unknownSenderPolicy: 'allow' as const,
      deniedAt: null,
      createdAt: new Date(),
    };
    mg = await db.upsertMessagingGroup(newMg);
    logger.info({ mgId: mg.id, platform: incoming.platform, chatId: incoming.platformChatId }, 'Auto-created messaging group');

    // Auto-seed default wiring with first group + its default/first agent so the chat
    // works zero-touch after first @mention. Admin can adjust later in /admin/messaging-groups.
    const firstGroup = groups.list()[0];
    const defaultAgentId = firstGroup?.defaultAgent ?? firstGroup?.agents[0];
    if (firstGroup && defaultAgentId) {
      const defaultEngageMode = adapter.supportsThreads && incoming.isGroup === true
        ? 'mention-sticky'
        : 'pattern';
      await db.addMessagingGroupAgent({
        messagingGroupId: mg.id,
        groupId: firstGroup.id,
        agentId: defaultAgentId,
        engageMode: defaultEngageMode,
        engagePattern: defaultEngageMode === 'pattern' ? '.' : null,
        sessionMode: 'per-user',
        ignoredMessagePolicy: 'accumulate',
        createdAt: new Date(),
      });
      logger.info(
        { mgId: mg.id, groupId: firstGroup.id, agentId: defaultAgentId, engageMode: defaultEngageMode },
        'Auto-seeded default wiring for new messaging group',
      );
    } else {
      logger.warn({ mgId: mg.id }, 'No groups configured - cannot auto-seed wiring');
    }
  }

  // Drop silently if channel was denied
  if (mg.deniedAt) {
    logger.debug({ mgId: mg.id, deniedAt: mg.deniedAt }, 'Message dropped - channel denied');
    return;
  }

  // 4. Reserved commands: /agents, /agent <id>, /agent off
  const text = incoming.text.trim();
  if (/^\/agents?(\s|$)/i.test(text)) {
    // /agents → list all wirings
    if (/^\/agents(\s|$)/i.test(text)) {
      const wirings = await db.listMessagingGroupAgents(mg.id);
      const listText = wirings.length > 0
        ? wirings.map((w) => `- ${w.groupId}/${w.agentId} [${w.engageMode}]`).join('\n')
        : 'No agents wired. Use /pair to set up.';
      const reply = `Wired agents:\n${listText}`;
      try {
        await adapter.send(
          { platform: incoming.platform, chatId: incoming.platformChatId, userId: incoming.platformUserId },
          { text: reply, format: 'plain' },
        );
      } catch (err) {
        logger.warn({ err }, '/agents reply send failed');
      }
      return;
    }

    // /agent off → remove all pattern='.' wirings
    if (/^\/agent\s+off$/i.test(text)) {
      const wirings = await db.listMessagingGroupAgents(mg.id);
      const alwaysTrigger = wirings.filter((w) => w.engageMode === 'pattern' && (w.engagePattern === '.' || w.engagePattern === null));
      for (const w of alwaysTrigger) {
        await db.removeMessagingGroupAgent(mg.id, w.groupId, w.agentId);
      }
      const reply = alwaysTrigger.length > 0
        ? `Removed ${alwaysTrigger.length} always-on agent(s). Use /agents to check.`
        : 'No always-on agents to remove.';
      try {
        await adapter.send(
          { platform: incoming.platform, chatId: incoming.platformChatId, userId: incoming.platformUserId },
          { text: reply, format: 'plain' },
        );
      } catch (err) {
        logger.warn({ err }, '/agent off reply send failed');
      }
      return;
    }

    // /agent <agentId> → switch always-on agent (remove existing pattern='.' wirings, add new one)
    const agentMatch = /^\/agent\s+(\S+)$/i.exec(text);
    if (agentMatch) {
      const targetAgentId = agentMatch[1]!;
      // Find a group that contains this agent
      const targetGroup = groups.list().find((g) => g.agents.includes(targetAgentId));
      if (!targetGroup) {
        try {
          await adapter.send(
            { platform: incoming.platform, chatId: incoming.platformChatId, userId: incoming.platformUserId },
            { text: `Agent "${targetAgentId}" not found. Use /agents to list available agents.`, format: 'plain' },
          );
        } catch { /* ignore */ }
        return;
      }
      // Remove existing pattern='.' wirings
      const wirings = await db.listMessagingGroupAgents(mg.id);
      const alwaysTrigger = wirings.filter((w) => w.engageMode === 'pattern' && (w.engagePattern === '.' || w.engagePattern === null));
      for (const w of alwaysTrigger) {
        await db.removeMessagingGroupAgent(mg.id, w.groupId, w.agentId);
      }
      // Add new always-on wiring for target agent
      await db.addMessagingGroupAgent({
        messagingGroupId: mg.id,
        groupId: targetGroup.id,
        agentId: targetAgentId,
        engageMode: 'pattern',
        engagePattern: '.',
        sessionMode: 'per-user',
        ignoredMessagePolicy: 'drop',
        createdAt: new Date(),
      });
      try {
        await adapter.send(
          { platform: incoming.platform, chatId: incoming.platformChatId, userId: incoming.platformUserId },
          { text: `Switched to agent "${targetAgentId}" (group: ${targetGroup.id}).`, format: 'plain' },
        );
      } catch (err) {
        logger.warn({ err }, '/agent switch reply send failed');
      }
      return;
    }
  }

  // 5. Get wirings
  const wirings = await db.listMessagingGroupAgents(mg.id);
  if (wirings.length === 0) {
    if (!isMention) return;
    logger.warn({ mgId: mg.id }, 'No wirings - message dropped');
    return;
  }

  // 6. Sender resolution
  const user = await auth.getOrCreatePlatformUser(
    incoming.platform,
    incoming.platformUserId ?? 'unknown',
    incoming.platformUserId ?? 'unknown',
  );

  // 7. Fan-out
  let engagedCount = 0;

  for (const wiring of wirings) {
    const group = groups.get(wiring.groupId);
    if (!group) {
      logger.warn({ groupId: wiring.groupId }, 'Wired group not found - skipping');
      continue;
    }
    if (!group.agents.includes(wiring.agentId)) {
      logger.warn({ groupId: wiring.groupId, agentId: wiring.agentId }, 'Wired agent not in group - skipping');
      continue;
    }

    const engages = await evaluateEngage(wiring, text, isMention, mg.isGroup, effectiveThreadId, incoming.platformUserId ?? '', db);

    if (engages) {
      const session = await sessions.resolveMessagingSession({
        userId: user.id,
        groupId: wiring.groupId,
        agentId: wiring.agentId,
        messagingGroupId: mg.id,
        threadId: effectiveThreadId,
        platform: incoming.platform,
        platformChatId: incoming.platformChatId,
        platformUserId: incoming.platformUserId ?? '',
        sessionMode: wiring.sessionMode,
      });

      void runAgentAndReply(deps, adapter, { ...incoming, threadId: effectiveThreadId }, session.sessionId);
      engagedCount++;
    } else if (wiring.ignoredMessagePolicy === 'accumulate') {
      // Silently store message for context
      const session = await sessions.resolveMessagingSession({
        userId: user.id,
        groupId: wiring.groupId,
        agentId: wiring.agentId,
        messagingGroupId: mg.id,
        threadId: effectiveThreadId,
        platform: incoming.platform,
        platformChatId: incoming.platformChatId,
        platformUserId: incoming.platformUserId ?? '',
        sessionMode: wiring.sessionMode,
      });
      try {
        await db.saveMessage({
          id: randomUUID(),
          sessionId: session.sessionId,
          role: 'user',
          content: text,
          createdAt: new Date(),
        });
      } catch (err) {
        logger.warn({ err }, 'accumulate saveMessage failed');
      }
    }
  }

  if (engagedCount === 0 && wirings.length > 0) {
    logger.debug({ mgId: mg.id, textLen: text.length, isMention }, 'No agent engaged for message');
  }
}

/**
 * Decide if a wired agent should engage on this message.
 *
 * 'pattern'        - regex test on text; '.' = always engage
 * 'mention'        - requires platform @mention
 * 'mention-sticky' - @mention OR existing thread session (sticky follow-up)
 */
async function evaluateEngage(
  wiring: MessagingGroupAgent,
  text: string,
  isMention: boolean,
  isGroupChat: boolean,
  threadId: string | null,
  platformUserId: string,
  db: DbStore,
): Promise<boolean> {
  switch (wiring.engageMode) {
    case 'pattern': {
      const pat = wiring.engagePattern ?? '.';
      if (pat === '.') return true;
      try {
        return new RegExp(pat, 'i').test(text);
      } catch {
        return true; // bad regex -> fail open
      }
    }
    case 'mention':
      return isMention;
    case 'mention-sticky': {
      if (isMention) return true;
      if (!isGroupChat) return false;
      // sticky follow-up: existing session for this user in this thread
      if (threadId !== null) {
        const existing = await db.findMessagingSession({
          groupId: wiring.groupId,
          agentId: wiring.agentId,
          messagingGroupId: wiring.messagingGroupId,
          threadId,
          platformUserId,
          sessionMode: 'per-thread',
        });
        return existing !== undefined;
      }
      return false;
    }
    default:
      return false;
  }
}

async function runAgentAndReply(
  deps: MessageProcessorDeps,
  adapter: MessagingAdapter,
  incoming: IncomingMessage,
  sessionId: string,
): Promise<void> {
  let buffer = '';
  const target = {
    platform: incoming.platform,
    chatId: incoming.platformChatId,
    userId: incoming.platformUserId,
  } as const;

  async function safeSend(sendText: string, format: 'plain' | 'markdown'): Promise<void> {
    if (!sendText.trim()) return;
    try {
      await adapter.send(target, { text: sendText, format });
    } catch (err) {
      deps.logger.error({ err, platform: incoming.platform, chatId: incoming.platformChatId }, 'adapter.send failed');
    }
  }

  try {
    for await (const event of deps.sessions.handleMessage(sessionId, incoming)) {
      if (event.type === 'chunk') buffer += event.delta;
      if (event.type === 'done' || event.type === 'message') {
        const responseText = event.type === 'message' ? event.content : buffer;
        await safeSend(responseText, 'plain');
        buffer = '';
      }
      if (event.type === 'error') {
        await safeSend(`Error: ${event.message}`, 'plain');
      }
    }
  } catch (err) {
    deps.logger.error({ err, sessionId }, 'agent loop failed for messaging');
  }
}
