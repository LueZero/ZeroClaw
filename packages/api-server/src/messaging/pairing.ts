/**
 * Pairing service - interactive chat binding (v0.3)
 *
 * Flow:
 *   1. Admin calls POST /api/pairings { groupId, platform, agentId?, engageMode?, sessionMode? }
 *   2. Admin sends the 4-digit code in the target chat
 *   3. message-processor calls tryConsume first:
 *        - match -> create messaging_group + messaging_group_agent wiring, reply success
 *        - no match -> route normally
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Platform, EngageMode, SessionMode } from '@zeroclaw/shared';
import type { DbStore, PairingCode } from '../db/db-store.js';

export interface CreatePairingInput {
  groupId: string;
  platform: Platform;
  agentId?: string;
  engageMode?: EngageMode;
  engagePattern?: string;
  sessionMode?: SessionMode;
}

export interface PairingService {
  /** Create 4-digit pairing code (invalidates previous pending code for same groupId+platform) */
  create(input: CreatePairingInput): Promise<PairingCode>;
  /** Try to consume a pending code; on match creates messaging_group + wiring */
  tryConsume(args: { text: string; platform: Platform; chatId: string; isGroup?: boolean }): Promise<
    | { matched: true; code: string; groupId: string }
    | { matched: false }
  >;
  /** Query code status (for frontend polling) */
  status(code: string): Promise<PairingCode | undefined>;
}

export function createPairingService(opts: { db: DbStore; logger: Logger }): PairingService {
  const { db, logger } = opts;

  async function generateCode(): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const code = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      if (!(await db.getPairing(code))) return code;
    }
    throw new Error('Failed to allocate pairing code');
  }

  return {
    async create(input) {
      await db.invalidatePendingPairings(input.groupId, input.platform);
      const record: PairingCode = {
        code: await generateCode(),
        groupId: input.groupId,
        platform: input.platform,
        agentId: input.agentId,
        engageMode: input.engageMode,
        engagePattern: input.engagePattern,
        sessionMode: input.sessionMode,
        status: 'pending',
        createdAt: new Date(),
      };
      await db.createPairing(record);
      logger.info({ code: record.code, groupId: input.groupId, platform: input.platform }, 'pairing created');
      return record;
    },

    async tryConsume({ text, platform, chatId, isGroup }) {
      const m = text.trim().match(/^(\d{4})$/);
      if (!m) return { matched: false };
      const code = m[1]!;
      const record = await db.getPairing(code);
      if (!record || record.status !== 'pending' || record.platform !== platform) {
        return { matched: false };
      }

      await db.consumePairing(code, chatId);

      // Create messaging_group + wiring
      const mg = await db.upsertMessagingGroup({
        id: `mg-${Date.now()}-${randomUUID().slice(0, 8)}`,
        platform,
        platformChatId: chatId,
        isGroup: isGroup ?? false,
        unknownSenderPolicy: 'allow',
        deniedAt: null,
        createdAt: new Date(),
      });

      if (record.agentId) {
        await db.addMessagingGroupAgent({
          messagingGroupId: mg.id,
          groupId: record.groupId,
          agentId: record.agentId,
          engageMode: record.engageMode ?? 'pattern',
          engagePattern: record.engagePattern ?? null,
          sessionMode: record.sessionMode ?? 'per-user',
          ignoredMessagePolicy: 'drop',
          createdAt: new Date(),
        });
        logger.info({ code, platform, chatId, groupId: record.groupId, agentId: record.agentId, mgId: mg.id }, 'pairing consumed - wiring created');
      } else {
        logger.info({ code, platform, chatId, groupId: record.groupId, mgId: mg.id }, 'pairing consumed - no agentId specified, add wirings via API');
      }

      return { matched: true as const, code, groupId: record.groupId };
    },

    async status(code) {
      return db.getPairing(code);
    },
  };
}


