/**
 * /api/auth/* – the only public API besides /api/health.
 * - GET  /api/auth/config        login page needs the mode + environment
 * - GET  /api/auth/dev-users     (AUTH_MODE=dev only) seeded users to pick
 * - POST /api/auth/dev-login     (AUTH_MODE=dev only) {userId}
 * - GET  /api/auth/login         (AUTH_MODE=entra) → Entra
 * - GET  /api/auth/callback      (AUTH_MODE=entra) ← Entra
 * - POST /api/auth/logout        deletes the session server-side
 */
import type { AuthConfigResponse, DevUser, Role } from '@sales-portal/shared';
import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { userRoles, users } from '../db/schema';
import { audit } from '../lib/audit';
import { notFound } from '../lib/errors';
import { endSessionUrl, finishLogin, startLogin } from './entra';
import { publicRoute, requireAuth } from './rbac';
import { clearSessionCookie, createSession, destroySession, destroySessionByRawId, SESSION_COOKIE, setSessionCookie } from './session';
import { loadSessionTokens } from './tokens';

export const LOGIN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { config, db } = app;

  app.get('/config', { config: publicRoute() }, async (): Promise<AuthConfigResponse> => ({
    authMode: config.auth.mode,
    environmentLabel: config.environmentLabel,
  }));

  if (config.auth.mode === 'dev') {
    app.get('/dev-users', { config: publicRoute() }, async (): Promise<DevUser[]> => {
      const rows = await db
        .select({ id: users.id, displayName: users.displayName, email: users.email, role: userRoles.role })
        .from(users)
        .leftJoin(userRoles, eq(userRoles.userId, users.id))
        .where(eq(users.isActive, true))
        .orderBy(asc(users.displayName));
      const map = new Map<string, DevUser>();
      for (const r of rows) {
        const u = map.get(r.id) ?? { id: r.id, displayName: r.displayName, email: r.email, roles: [] as Role[] };
        if (r.role) u.roles.push(r.role as Role);
        map.set(r.id, u);
      }
      return [...map.values()];
    });

    app.post(
      '/dev-login',
      {
        config: { ...publicRoute({ csrf: 'origin-only' }), rateLimit: LOGIN_RATE_LIMIT },
        schema: { body: z.object({ userId: z.string().uuid() }) },
      },
      async (request, reply) => {
        const [user] = await db.select().from(users).where(eq(users.id, request.body.userId));
        if (!user || !user.isActive) throw notFound('Benutzer nicht gefunden');
        await destroySessionByRawId(db, config, request.cookies[SESSION_COOKIE]); // rotation
        const session = await createSession(db, config, { userId: user.id, method: 'dev', userAgent: request.headers['user-agent'] ?? null });
        await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
        setSessionCookie(reply, config, session);
        await audit(db, { actor: { userId: user.id, displayName: user.displayName }, action: 'auth.login', entity: 'user', entityId: user.id, meta: { method: 'dev' } });
        return { ok: true };
      },
    );
  }

  if (config.auth.mode === 'entra') {
    app.get(
      '/login',
      {
        config: { ...publicRoute(), rateLimit: LOGIN_RATE_LIMIT },
        schema: { querystring: z.object({ returnTo: z.string().max(500).optional() }) },
      },
      async (request, reply) => startLogin(request, reply, config),
    );
    app.get(
      '/callback',
      {
        config: { ...publicRoute(), rateLimit: LOGIN_RATE_LIMIT },
        schema: {
          querystring: z
            .object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() })
            .passthrough(),
        },
      },
      async (request, reply) => finishLogin(request, reply, db, config),
    );
  }

  app.post('/logout', { config: requireAuth() }, async (request, reply) => {
    const auth = request.auth!;
    let redirectUrl = '/login';
    if (config.auth.mode === 'entra') {
      const tokens = await loadSessionTokens(db, config, auth.sessionIdHash);
      redirectUrl = await endSessionUrl(config, tokens?.idToken ?? null);
    }
    await destroySession(db, auth.sessionIdHash);
    clearSessionCookie(reply, config);
    await audit(db, { actor: auth.actor, action: 'auth.logout', entity: 'user', entityId: auth.user.id });
    return { redirectUrl };
  });
};
