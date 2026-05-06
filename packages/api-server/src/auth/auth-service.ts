/**
 * 認證 — JWT 為主，配合通訊平台 webhook 的 platformUserId 自動建立 user 帳號
 */

import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { Errors } from '@zeroclaw/shared';
import type { AuthContext, Platform, User, Role } from '@zeroclaw/shared';
import type { DbStore } from '../db/db-store.js';

export interface AuthService {
  signToken(ctx: AuthContext): Promise<string>;
  verifyToken(token: string): Promise<AuthContext>;
  getOrCreatePlatformUser(
    platform: Platform,
    externalId: string,
    displayName: string,
  ): Promise<User>;
}

export function createAuthService(opts: {
  db: DbStore;
  jwtSecret: string;
  expiresIn: string;
}): AuthService {
  const secret = new TextEncoder().encode(opts.jwtSecret);

  async function signToken(ctx: AuthContext): Promise<string> {
    return await new SignJWT({ role: ctx.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(ctx.userId)
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn)
      .sign(secret);
  }

  async function verifyToken(token: string): Promise<AuthContext> {
    try {
      const { payload } = await jwtVerify(token, secret);
      if (!payload.sub) throw new Error('no subject');
      return { userId: payload.sub, role: (payload['role'] as Role) ?? 'member' };
    } catch {
      throw Errors.unauthorized('Invalid token');
    }
  }

  async function getOrCreatePlatformUser(
    platform: Platform,
    externalId: string,
    displayName: string,
  ): Promise<User> {
    const existing = await opts.db.findUserByPlatformId(platform, externalId);
    if (existing) return existing;

    const user: User = {
      id: randomUUID(),
      role: 'member',
      displayName,
      externalIds: {
        web: undefined,
        telegram: undefined,
        whatsapp: undefined,
        discord: undefined,
        slack: undefined,
        teams: undefined,
        [platform]: externalId,
      },
      createdAt: new Date(),
    };
    await opts.db.upsertUser(user);
    return user;
  }

  return { signToken, verifyToken, getOrCreatePlatformUser };
}
