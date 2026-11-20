/**
 * Foundation fixes: no bound query values in logs / jobs.last_error, dev login only on loopback, TRUST_PROXY without
 * «trust everything», rate limits per user, Entra linking by oid/UPN (no guests, no demo users), bootstrap admin only on
 * the first login, demo seed covers all Pendenzen states.
 */
import { Writable } from 'node:stream';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rateLimitKey } from '../src/app';
import { isGuestAccount, signInName, upsertUser } from '../src/auth/entra';
import { requireAuth } from '../src/auth/rbac';
import { ConfigError, isLocalUrl, isLoopbackHost, loadConfig, parseTrustProxy, type AppConfig } from '../src/config';
import { auditLog, bookings, callSessions, changeSets, jobs, mockCalendarEvents, notifications, userRoles, users } from '../src/db/schema';
import { DEMO_USERS } from '../src/db/seed/users';
import { enqueueJob } from '../src/jobs/queue';
import { JobRegistry } from '../src/jobs/registry';
import { JobRunner } from '../src/jobs/runner';
import { createLogger, loggerOptions, safeErrorMessage, serializeError, stripQueryParams } from '../src/lib/logger';
import { MODULES } from '../src/modules';
import { defineModule } from '../src/modules/registry';
import { createTestApp, ORIGIN, type TestApp } from './helpers';
import pino from 'pino';

const SECRET_MAIL = 'geheim.person@example.ch';
const SECRET_NOTE = 'Kunde hat Burnout\nund will nicht mehr';

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
}

/** A real DrizzleQueryError: unique violation on users.email with personal data in the bound params. */
async function failingQuery(t: TestApp): Promise<unknown> {
  try {
    await t.ctx.db.insert(users).values({ email: DEMO_USERS[0].email, displayName: SECRET_NOTE, phoneE164: '+41615550199', crmUserId: SECRET_MAIL });
  } catch (err) {
    return err;
  }
  throw new Error('expected the insert to fail');
}

// =====================================================================================================================

describe('logging – failed DB queries never expose bound values (§5.8)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('safeErrorMessage keeps the SQL and the pg code, drops all params', async () => {
    const err = await failingQuery(t);
    expect(String((err as Error).message)).toContain(SECRET_MAIL); // drizzle's raw message really contains it
    const safe = safeErrorMessage(err);
    expect(safe).toMatch(/^Failed query: insert into "users"/);
    expect(safe).toContain('23505');
    expect(safe).not.toContain(SECRET_MAIL);
    expect(safe).not.toContain('Burnout');
    expect(safe).not.toContain('+41615550199');
  });

  it('the err serializer drops params, message values, stack header and pg detail – also as a nested cause', async () => {
    const err = await failingQuery(t);
    const direct = JSON.stringify(serializeError(err));
    const wrapped = JSON.stringify(serializeError(new Error('upsert failed', { cause: err })));
    for (const out of [direct, wrapped]) {
      expect(out).not.toContain(SECRET_MAIL);
      expect(out).not.toContain('Burnout');
      expect(out).not.toContain('+41615550199');
      expect(out).toContain('Failed query');
    }
    expect(direct).toContain('users_email_uq');
  });

  it('pino logger output (error handler / job runner style) contains no bound values', async () => {
    const err = await failingQuery(t);
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino(loggerOptions('info', false), stream);
    log.error({ err }, 'unhandled error');
    log.warn({ err: { message: (err as Error).message } }, 'hook failed');
    const out = lines.join('');
    expect(lines).toHaveLength(2);
    expect(out).not.toContain(SECRET_MAIL);
    expect(out).not.toContain('Burnout');
    expect(out).toContain('params: [redacted]');
  });

  it('stripQueryParams leaves normal messages alone and cuts params up to the stack frames', () => {
    expect(stripQueryParams('Lead nicht gefunden')).toBe('Lead nicht gefunden');
    const stack = `Error: Failed query: select 1\nparams: a@b.ch,${SECRET_NOTE}\n    at foo (x.js:1:1)\n    at bar (y.js:2:2)`;
    const out = stripQueryParams(stack);
    expect(out).not.toContain('Burnout');
    expect(out).toContain('    at foo (x.js:1:1)');
  });

  it('jobs.last_error stores the sanitised message (shown in Admin › Fehler)', async () => {
    const registry = new JobRegistry();
    registry.register('test.db_fail', async () => {
      await t.ctx.db.insert(users).values({ email: DEMO_USERS[0].email, displayName: 'x', crmUserId: SECRET_MAIL });
    });
    await enqueueJob(t.ctx.db, 'test.db_fail', {}, { maxAttempts: 2 });
    const runner = new JobRunner({ config: t.ctx.config, db: t.ctx.db, adapters: t.ctx.adapters.system(), log: createLogger('silent'), registry });
    await runner.tick();
    const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.type, 'test.db_fail'));
    expect(row.lastError).toMatch(/^Failed query: insert into "users"/);
    expect(row.lastError).not.toContain(SECRET_MAIL);
  });
});

// =====================================================================================================================

describe('config – dev login only on this machine, TRUST_PROXY never «everything»', () => {
  const dev = { NODE_ENV: 'development', LOG_LEVEL: 'silent' };

  it('refuses AUTH_MODE=dev on a network interface or with a non-local PUBLIC_URL, also outside production', () => {
    expect(problemsOf({ ...dev, HOST: '0.0.0.0' }).join()).toMatch(/AUTH_MODE=dev nur mit HOST/);
    expect(problemsOf({ ...dev, HOST: '10.1.2.3' }).join()).toMatch(/AUTH_MODE=dev nur mit HOST/);
    expect(problemsOf({ ...dev, NODE_ENV: 'test', HOST: '::' }).join()).toMatch(/AUTH_MODE=dev nur mit HOST/);
    expect(problemsOf({ ...dev, PUBLIC_URL: 'http://sales-portal.intern' }).join()).toMatch(/PUBLIC_URL auf localhost/);
    expect(problemsOf(dev)).toEqual([]);
    expect(problemsOf({ ...dev, HOST: 'localhost', PUBLIC_URL: 'http://127.0.0.1:3000' })).toEqual([]);
    expect(problemsOf({ ...dev, HOST: '::1', PUBLIC_URL: 'http://portal.localhost:5173' })).toEqual([]);
  });

  it('AUTH_MODE=entra may listen on all interfaces', () => {
    const entra = {
      ...dev,
      HOST: '0.0.0.0',
      AUTH_MODE: 'entra',
      PUBLIC_URL: 'https://portal.intern.example',
      ENTRA_TENANT_ID: 't',
      ENTRA_CLIENT_ID: 'c',
      ENTRA_CLIENT_SECRET: 's',
      TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString('base64'),
    };
    expect(problemsOf(entra)).toEqual([]);
  });

  it('loopback / local URL helpers', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', 'LOCALHOST']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['0.0.0.0', '::', '10.0.0.1', 'portal.intern', '128.0.0.1']) expect(isLoopbackHost(h)).toBe(false);
    expect(isLocalUrl('http://localhost:5173')).toBe(true);
    expect(isLocalUrl('http://app.localhost')).toBe(true);
    expect(isLocalUrl('https://localhost.evil.example')).toBe(false);
    expect(isLocalUrl('not a url')).toBe(false);
  });

  it('TRUST_PROXY: false or concrete proxy addresses; «true» and hop counts are refused', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('172.18.0.1')).toBe('172.18.0.1');
    expect(parseTrustProxy(' 10.0.0.0/8 , ::1 ')).toBe('10.0.0.0/8,::1');
    expect(parseTrustProxy('loopback,uniquelocal')).toBe('loopback,uniquelocal');
    for (const bad of ['true', 'yes', '1', '2', '10.0.0.0/33', 'proxy.intern', '*']) expect(parseTrustProxy(bad)).toBeNull();
    expect(problemsOf({ ...dev, TRUST_PROXY: 'true' }).join()).toMatch(/TRUST_PROXY/);
    expect(loadConfig({ ...dev, TRUST_PROXY: '172.18.0.1' }).trustProxy).toBe('172.18.0.1');
    expect(loadConfig(dev).trustProxy).toBe(false);
  });
});

// =====================================================================================================================

const limitedRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/ping', { config: { ...requireAuth(), rateLimit: { max: 3, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
};
const limitedModule = defineModule({ name: 'limitedtest', routes: limitedRoutes });

describe('rate limits – per user when signed in, X-Forwarded-For not client-controlled', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { TRUST_PROXY: '127.0.0.1' }, modules: [...MODULES, limitedModule] });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('rateLimitKey: user id when signed in, IP otherwise', () => {
    expect(rateLimitKey({ auth: null, ip: '10.0.0.7' })).toBe('ip:10.0.0.7');
    expect(rateLimitKey({ auth: { user: { id: 'u1' } } as never, ip: '10.0.0.7' })).toBe('user:u1');
  });

  it('a signed-in user cannot escape the limit with rotating X-Forwarded-For; another user has an own bucket', async () => {
    const markus = await t.login('markus');
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await t.app.inject({ method: 'GET', url: '/api/limitedtest/ping', headers: { cookie: markus.cookie, 'x-forwarded-for': `198.51.100.${i}` } });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const manuel = await t.login('manuel');
    const res = await t.app.inject({ method: 'GET', url: '/api/limitedtest/ping', headers: { cookie: manuel.cookie, 'x-forwarded-for': '198.51.100.1' } });
    expect(res.statusCode).toBe(200);
  });

  it('anonymous login limit: entries the client puts in front of X-Forwarded-For do not give a fresh bucket', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/dev-login',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i}, 192.0.2.44` },
        payload: { userId: '00000000-0000-4000-8000-0000000000ff' },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 404)).toBe(true); // unknown user, but counted
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});

// =====================================================================================================================

describe('Entra login – identity by oid, first link by UPN (members only), bootstrap admin once', () => {
  let t: TestApp;
  let config: AppConfig;
  const TENANT = '11111111-2222-3333-4444-555555555555';
  beforeAll(async () => {
    t = await createTestApp();
    config = {
      ...t.ctx.config,
      auth: {
        ...t.ctx.config.auth,
        entra: { tenantId: TENANT, clientId: 'c', clientSecret: 's', scopes: [], redirectUri: '', postLogoutRedirectUri: '' },
        bootstrapAdminEmails: ['chefin@kallysoft.ch'],
      },
    };
  });
  afterAll(async () => {
    await t?.close();
  });

  const rolesOf = async (userId: string) =>
    (await t.ctx.db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId))).map((r) => r.role).sort();

  it('signInName uses the UPN, never the email claim', () => {
    expect(signInName({ preferred_username: 'Anna@Kallysoft.ch', email: 'other@kallysoft.ch' })).toBe('anna@kallysoft.ch');
    expect(signInName({ upn: 'anna@kallysoft.ch' })).toBe('anna@kallysoft.ch');
    expect(signInName({ email: 'anna@kallysoft.ch' })).toBeNull();
  });

  it('guest detection: acct=1, foreign idp, #EXT# UPN', () => {
    expect(isGuestAccount({ acct: 1 }, TENANT)).toBe(true);
    expect(isGuestAccount({ idp: 'https://sts.windows.net/99999999-0000-0000-0000-000000000000/' }, TENANT)).toBe(true);
    expect(isGuestAccount({ idp: 'live.com' }, TENANT)).toBe(true);
    expect(isGuestAccount({ upn: 'x_partner.ch#EXT#@kallysoft.onmicrosoft.com' }, TENANT)).toBe(true);
    expect(isGuestAccount({ acct: 0, preferred_username: 'anna@kallysoft.ch' }, TENANT)).toBe(false);
    expect(isGuestAccount({ idp: `https://sts.windows.net/${TENANT}/` }, TENANT)).toBe(false);
  });

  it('links a member to the pre-created user by UPN and keeps its roles; later logins match by oid', async () => {
    const [pre] = await t.ctx.db.insert(users).values({ email: 'anna@kallysoft.ch', displayName: 'Anna' }).returning();
    await t.ctx.db.insert(userRoles).values({ userId: pre.id, role: 'sales' });
    const first = await upsertUser(t.ctx.db, config, { oid: 'oid-anna', tid: TENANT, preferred_username: 'anna@kallysoft.ch', name: 'Anna Muster' });
    expect(first.id).toBe(pre.id);
    expect(await rolesOf(pre.id)).toEqual(['sales']);
    // UPN renamed later: still the same portal user (oid).
    const again = await upsertUser(t.ctx.db, config, { oid: 'oid-anna', tid: TENANT, preferred_username: 'anna.muster@kallysoft.ch' });
    expect(again.id).toBe(pre.id);
  });

  it('a matching (editable) email claim does not link to a pre-created user', async () => {
    const [pre] = await t.ctx.db.insert(users).values({ email: 'beat@kallysoft.ch', displayName: 'Beat' }).returning();
    await t.ctx.db.insert(userRoles).values({ userId: pre.id, role: 'coldcaller' });
    const u = await upsertUser(t.ctx.db, config, { oid: 'oid-mallory', tid: TENANT, preferred_username: 'mallory@kallysoft.ch', email: 'beat@kallysoft.ch' });
    expect(u.id).not.toBe(pre.id);
    expect(await rolesOf(u.id)).toEqual([]);
    const [still] = await t.ctx.db.select().from(users).where(eq(users.id, pre.id));
    expect(still.entraOid).toBeNull();
  });

  it('guests are never linked to a pre-created user; demo users and already linked users are never claimed', async () => {
    await t.ctx.db.insert(users).values({ email: 'carla@kallysoft.ch', displayName: 'Carla' });
    await expect(
      upsertUser(t.ctx.db, config, { oid: 'oid-guest', tid: TENANT, preferred_username: 'carla@kallysoft.ch', acct: 1 }),
    ).rejects.toMatchObject({ reason: 'guest_link_refused' });
    await expect(
      upsertUser(t.ctx.db, config, { oid: 'oid-demo', tid: TENANT, preferred_username: DEMO_USERS[0].email }),
    ).rejects.toMatchObject({ reason: 'demo_user_not_linkable' });
    await expect(
      upsertUser(t.ctx.db, config, { oid: 'oid-other', tid: TENANT, preferred_username: 'anna.muster@kallysoft.ch' }),
    ).resolves.toBeTruthy(); // new user (anna's row has email anna@…)
    await expect(upsertUser(t.ctx.db, config, { tid: TENANT, preferred_username: 'x@kallysoft.ch' })).rejects.toMatchObject({ reason: 'missing_oid' });
  });

  it('bootstrap admin only on the first login (or while no active admin exists), never for guests', async () => {
    const boss = await upsertUser(t.ctx.db, config, { oid: 'oid-boss', tid: TENANT, preferred_username: 'chefin@kallysoft.ch' });
    expect(await rolesOf(boss.id)).toEqual(['admin']);
    // Revoked in the portal (Lukas demo admin is still active) → not granted again at the next login.
    await t.ctx.db.delete(userRoles).where(and(eq(userRoles.userId, boss.id), eq(userRoles.role, 'admin')));
    await upsertUser(t.ctx.db, config, { oid: 'oid-boss', tid: TENANT, preferred_username: 'chefin@kallysoft.ch' });
    expect(await rolesOf(boss.id)).toEqual([]);
    // No active admin left at all → the bootstrap address may recover access.
    const admins = await t.ctx.db.select({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.role, 'admin'));
    await t.ctx.db.update(users).set({ isActive: false }).where(inArray(users.id, admins.map((a) => a.userId)));
    await upsertUser(t.ctx.db, config, { oid: 'oid-boss', tid: TENANT, preferred_username: 'chefin@kallysoft.ch' });
    expect(await rolesOf(boss.id)).toEqual(['admin']);
    const grants = await t.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'admin.role_grant'), eq(auditLog.entityId, boss.id)));
    expect(grants).toHaveLength(2);
    await t.ctx.db.update(users).set({ isActive: true }).where(inArray(users.id, admins.map((a) => a.userId)));
  });

  it('a guest with a bootstrap UPN gets no admin role', async () => {
    const guestConfig = { ...config, auth: { ...config.auth, bootstrapAdminEmails: ['gast@partner.ch'] } };
    await t.ctx.db.update(users).set({ isActive: false }).where(eq(users.isActive, true));
    const g = await upsertUser(t.ctx.db, guestConfig, { oid: 'oid-gast', tid: TENANT, preferred_username: 'gast@partner.ch', idp: 'live.com' });
    expect(await rolesOf(g.id)).toEqual([]);
  });
});

// =====================================================================================================================

describe('demo seed – every Pendenzen state is there on the first click-through', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ demoCrm: true });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('seeds analysable calls, an unfinished call, draft + failed change sets, cancellation, reschedule, notifications, audit', async () => {
    const db = t.ctx.db;
    const sessions = await db.select().from(callSessions);
    const recentCompleted = sessions.filter(
      (s) => s.status === 'completed' && s.veraEnabled && s.connectedAt && s.endedAt && Date.now() - s.endedAt.getTime() < 20 * 60_000 && s.crmPhonecallId,
    );
    expect(recentCompleted.length).toBeGreaterThanOrEqual(2);
    expect(sessions.some((s) => s.status === 'ended' && s.category === 'outbound' && !s.resultGroup && !s.crmPhonecallId)).toBe(true);

    const sets = await db.select().from(changeSets);
    expect(sets.filter((c) => c.status === 'pushed')).toHaveLength(recentCompleted.length);
    expect(sets.some((c) => c.status === 'draft' && c.kind === 'phone_fix')).toBe(true);
    expect(sets.some((c) => c.status === 'failed' && c.error)).toBe(true);

    const bk = await db.select().from(bookings);
    const cancelled = bk.find((b) => b.status === 'cancelled');
    expect(cancelled).toBeTruthy();
    expect(bk.some((b) => b.status === 'rescheduled')).toBe(true);
    const events = await db.select().from(mockCalendarEvents);
    expect(events.some((e) => (e.extendedProperties as Record<string, string> | null)?.KlsTerminId === cancelled!.bookingRef)).toBe(false);

    const notes = await db.select().from(notifications);
    expect(notes.map((n) => n.kind).sort()).toEqual(['campaign_reply', 'mail_failed']);
    expect((await db.select().from(auditLog)).length).toBeGreaterThan(5);
  });

  it('Markus sees unfinished calls, approvals, errors, cancellations and campaign replies in Pendenzen', async () => {
    const markus = await t.login('markus');
    const res = await t.app.inject({ method: 'GET', url: '/api/pendenzen', headers: { cookie: markus.cookie } });
    expect(res.statusCode).toBe(200);
    const kinds = new Set((res.json().items as { kind: string }[]).map((i) => i.kind));
    for (const k of ['unfinished_call', 'approval', 'error', 'cancellation', 'campaign_reply']) expect(kinds.has(k), k).toBe(true);
  });

  it('the header restores the unfinished outbound call – a missed callback is never shown as «Nachbearbeitung»', async () => {
    const markus = await t.login('markus');
    const res = await t.app.inject({ method: 'GET', url: '/api/calls/active', headers: { cookie: markus.cookie } });
    expect(res.statusCode).toBe(200);
    const call = res.json().call as { category: string; status: string } | null;
    expect(call).toMatchObject({ category: 'outbound', status: 'ended' });
  });
});

// =====================================================================================================================

describe('key hints on buttons match the «?» overview (web helper, platform-aware)', async () => {
  const { kbdLabel, keyLabel } = await import('../../web/src/components/ui/keys');

  it('written labels: Ctrl → ⌘ on a Mac only', () => {
    expect(kbdLabel('Ctrl ↵', false)).toBe('Ctrl ↵');
    expect(kbdLabel('Ctrl ↵', true)).toBe('⌘ ↵');
    expect(kbdLabel('Ctrl S', true)).toBe('⌘ S');
    expect(kbdLabel('N', true)).toBe('N');
  });

  it('registered combos are rendered like the overview', () => {
    expect(kbdLabel('mod+enter', false)).toBe('Ctrl ↵');
    expect(kbdLabel('mod+enter', true)).toBe('⌘ ↵');
    expect(kbdLabel('n', true)).toBe('N');
    expect(kbdLabel('g a', false)).toBe('G dann A');
    expect(keyLabel('mod', true)).toBe('⌘');
    expect(keyLabel('escape', false)).toBe('Esc');
  });
});
