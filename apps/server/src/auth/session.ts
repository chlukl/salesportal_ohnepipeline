/**
 * Server-side sessions (ARCHITECTURE §5.2): cookie `sp_sid` (httpOnly, Secure in prod, SameSite=Lax, Path=/),
 * id = 32 random bytes, stored only as HMAC-SHA256 hash. Idle timeout 12 h, absolute 7 days, rotation on login,
 * logout deletes server-side.
 */
import type { Role } from '@sales-portal/shared';
import { and, eq, lt, or } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import { sessions, userRoles, users } from '../db/schema';
import { hashSessionId, randomToken } from './crypto';
import { computeEffectiveRoles, type RequestAuth } from './rbac';

export const SESSION_COOKIE = 'sp_sid';
/** Only refresh last_seen_at when older than this (avoid a write per request). */
const TOUCH_INTERVAL_MS = 60_000;

export interface CreatedSession {
  rawId: string;
  idHash: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(
  db: Db,
  config: AppConfig,
  input: { userId: string; method: 'dev' | 'entra'; userAgent?: string | null; tokensEnc?: string | null; tokenExpiresAt?: Date | null },
): Promise<CreatedSession> {
  const rawId = randomToken(32);
  const idHash = hashSessionId(config.auth.sessionSecret, rawId);
  const csrfToken = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.auth.absoluteTimeoutMs);
  await db.insert(sessions).values({
    idHash,
    userId: input.userId,
    csrfToken,
    authMethod: input.method,
    tokensEnc: input.tokensEnc ?? null,
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    userAgent: input.userAgent ? input.userAgent.slice(0, 200) : null,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  });
  return { rawId, idHash, csrfToken, expiresAt };
}

export function setSessionCookie(reply: FastifyReply, config: AppConfig, session: Pick<CreatedSession, 'rawId' | 'expiresAt'>): void {
  reply.setCookie(SESSION_COOKIE, session.rawId, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    expires: session.expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/' });
}

export async function destroySessionByRawId(db: Db, config: AppConfig, rawId: string | undefined): Promise<void> {
  if (!rawId) return;
  await db.delete(sessions).where(eq(sessions.idHash, hashSessionId(config.auth.sessionSecret, rawId)));
}

export async function destroySession(db: Db, idHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.idHash, idHash));
}

/** Load and validate a session from the raw cookie value; returns null when missing/expired/inactive. */
export async function loadSession(db: Db, config: AppConfig, rawId: string | undefined): Promise<RequestAuth | null> {
  if (!rawId || rawId.length < 20 || rawId.length > 100) return null;
  const idHash = hashSessionId(config.auth.sessionSecret, rawId);
  const [row] = await db
    .select({
      idHash: sessions.idHash,
      csrfToken: sessions.csrfToken,
      viewAsRole: sessions.viewAsRole,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      crmUserId: users.crmUserId,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.idHash, idHash));
  if (!row) return null;

  const now = Date.now();
  const idleExpired = now - row.lastSeenAt.getTime() > config.auth.idleTimeoutMs;
  const absoluteExpired = now >= row.expiresAt.getTime();
  if (idleExpired || absoluteExpired || !row.isActive) {
    await destroySession(db, idHash);
    return null;
  }
  if (now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.update(sessions).set({ lastSeenAt: new Date(now) }).where(eq(sessions.idHash, idHash));
  }

  const roleRows = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, row.userId));
  const roles = roleRows.map((r) => r.role as Role).sort();
  const { effectiveRoles, viewAs } = computeEffectiveRoles(roles, (row.viewAsRole as Role | null) ?? null);
  return {
    sessionIdHash: idHash,
    csrfToken: row.csrfToken,
    user: { id: row.userId, email: row.email, displayName: row.displayName, crmUserId: row.crmUserId },
    roles,
    effectiveRoles,
    viewAs,
    isRealAdmin: roles.includes('admin'),
    actor: { kind: 'user', userId: row.userId, displayName: row.displayName, crmUserId: row.crmUserId, email: row.email },
  };
}

export async function setViewAs(db: Db, idHash: string, role: Role | null): Promise<void> {
  await db.update(sessions).set({ viewAsRole: role }).where(eq(sessions.idHash, idHash));
}

/** Remove expired / idle sessions (worker job). */
export async function purgeExpiredSessions(db: Db, config: AppConfig): Promise<void> {
  const now = new Date();
  const idleBefore = new Date(now.getTime() - config.auth.idleTimeoutMs);
  await db.delete(sessions).where(or(lt(sessions.expiresAt, now), lt(sessions.lastSeenAt, idleBefore)));
}

/** Delete every session of a user (role change, deactivation). */
export async function destroyUserSessions(db: Db, userId: string, exceptIdHash?: string): Promise<void> {
  if (exceptIdHash) {
    const all = await db.select({ idHash: sessions.idHash }).from(sessions).where(eq(sessions.userId, userId));
    for (const s of all) if (s.idHash !== exceptIdHash) await destroySession(db, s.idHash);
    return;
  }
  await db.delete(sessions).where(and(eq(sessions.userId, userId)));
}
