import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RouteSecurityError } from '../src/auth/plugin';
import { publicRoute, requireRoles } from '../src/auth/rbac';
import { MODULES } from '../src/modules';
import { defineModule } from '../src/modules/registry';
import { createTestApp, ORIGIN, type TestApp } from './helpers';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t?.close();
});

describe('authentication', () => {
  it('health is public and reveals nothing', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('API routes require a session', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('sets a hardened session cookie and rejects forged cookies', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/dev-login',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { userId: '00000000-0000-4000-8000-000000000002' },
    });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/sp_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    const forged = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: 'sp_sid=abcdefghijklmnopqrstuvwxyz0123456789' } });
    expect(forged.statusCode).toBe(401);
  });

  it('logout deletes the session server-side', async () => {
    const s = await t.login('manuel', { fresh: true });
    const out = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: s.headers });
    expect(out.statusCode).toBe(200);
    const after = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: s.cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('sends security headers (CSP, no-referrer, nosniff, frame-ancestors none)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('CSRF', () => {
  it('rejects a POST without X-CSRF-Token', async () => {
    const s = await t.login('lukas');
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/me/view-as',
      headers: { cookie: s.cookie, origin: ORIGIN, 'content-type': 'application/json' },
      payload: { role: 'sales' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_token');
  });

  it('rejects a wrong token', async () => {
    const s = await t.login('lukas');
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/me/view-as',
      headers: { ...s.headers, 'x-csrf-token': `${s.csrf.slice(0, -2)}xx`, 'content-type': 'application/json' },
      payload: { role: 'sales' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_token');
  });

  it('rejects a foreign Origin even with a valid token', async () => {
    const s = await t.login('lukas');
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/me/view-as',
      headers: { ...s.headers, origin: 'https://evil.example', 'content-type': 'application/json' },
      payload: { role: 'sales' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_origin');
  });

  it('rejects requests without any same-origin signal; accepts Sec-Fetch-Site same-origin', async () => {
    const s = await t.login('lukas');
    const { origin: _origin, ...noOrigin } = s.headers;
    const blocked = await t.app.inject({
      method: 'DELETE',
      url: '/api/me/view-as',
      headers: noOrigin,
    });
    expect(blocked.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'DELETE', url: '/api/me/view-as', headers: { ...noOrigin, 'sec-fetch-site': 'same-origin' } });
    expect(ok.statusCode).toBe(200);
  });

  it('dev login (no session yet) still requires a same-origin signal', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/dev-login',
      headers: { 'content-type': 'application/json' },
      payload: { userId: '00000000-0000-4000-8000-000000000002' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('RBAC', () => {
  it('coldcaller never sees the dashboard or admin', async () => {
    const s = await t.login('markus');
    expect((await t.app.inject({ method: 'GET', url: '/api/dashboard/summary', headers: { cookie: s.cookie } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: s.cookie } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: s.cookie } })).statusCode).toBe(200);
  });

  it('sales cannot use the call list, admin can', async () => {
    const sales = await t.login('manuel');
    expect((await t.app.inject({ method: 'GET', url: '/api/leads', headers: { cookie: sales.cookie } })).statusCode).toBe(403);
    const admin = await t.login('lukas');
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: admin.cookie } })).statusCode).toBe(200);
  });

  it('every registered /api route declares roles (default deny)', async () => {
    const routes = t.app.printRoutes({ commonPrefix: false });
    expect(routes).toContain('/api/me');
    // Building an app with an undeclared route fails at registration.
    const undeclared: FastifyPluginAsyncZod = async (app) => {
      app.get('/open', async () => ({ leaked: true }));
    };
    await expect(createTestApp({ modules: [...MODULES, defineModule({ name: 'evil', routes: undeclared })] })).rejects.toThrow(RouteSecurityError);
  });

  it('public routes are only allowed for health and auth', async () => {
    const sneaky: FastifyPluginAsyncZod = async (app) => {
      app.get('/data', { config: publicRoute() }, async () => ({ leaked: true }));
    };
    await expect(createTestApp({ modules: [defineModule({ name: 'sneaky', routes: sneaky })] })).rejects.toThrow(RouteSecurityError);
  });

  it('declared routes work as expected', async () => {
    const fine: FastifyPluginAsyncZod = async (app) => {
      app.get('/ping', { config: requireRoles('sales') }, async () => ({ pong: true }));
    };
    const other = await createTestApp({ modules: [...MODULES, defineModule({ name: 'fine', routes: fine })] });
    try {
      const sales = await other.login('manuel');
      expect((await other.app.inject({ method: 'GET', url: '/api/fine/ping', headers: { cookie: sales.cookie } })).statusCode).toBe(200);
      const caller = await other.login('markus');
      expect((await other.app.inject({ method: 'GET', url: '/api/fine/ping', headers: { cookie: caller.cookie } })).statusCode).toBe(403);
    } finally {
      await other.close();
    }
  });
});

describe('«Ansicht als» (view as)', () => {
  it('real admin can view as coldcaller: effective roles shrink, return is always allowed', async () => {
    const s = await t.login('lukas');
    const json = { ...s.headers, 'content-type': 'application/json' };

    const set = await t.app.inject({ method: 'PUT', url: '/api/me/view-as', headers: json, payload: { role: 'coldcaller' } });
    expect(set.statusCode).toBe(200);

    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: s.cookie } })).json();
    expect(me.viewAs).toBe('coldcaller');
    expect(me.effectiveRoles).toEqual(['coldcaller']);
    expect(me.roles).toContain('admin');
    expect(me.isRealAdmin).toBe(true);

    // Authorization uses the effective role.
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: s.cookie } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/dashboard/summary', headers: { cookie: s.cookie } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/leads?pageSize=1', headers: { cookie: s.cookie } })).statusCode).toBe(200);

    // Switching to another role while viewing is allowed (real admin) …
    const sw = await t.app.inject({ method: 'PUT', url: '/api/me/view-as', headers: json, payload: { role: 'sales' } });
    expect(sw.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/dashboard/summary', headers: { cookie: s.cookie } })).statusCode).toBe(200);

    // … and returning is always allowed.
    const back = await t.app.inject({ method: 'DELETE', url: '/api/me/view-as', headers: s.headers });
    expect(back.statusCode).toBe(200);
    expect(back.json().viewAs).toBeNull();
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: s.cookie } })).statusCode).toBe(200);
  });

  it('non-admins cannot use «Ansicht als»', async () => {
    const s = await t.login('markus');
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/me/view-as',
      headers: { ...s.headers, 'content-type': 'application/json' },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/me/view-as', headers: s.headers })).statusCode).toBe(403);
  });

  it('validates the role', async () => {
    const s = await t.login('lukas');
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/me/view-as',
      headers: { ...s.headers, 'content-type': 'application/json' },
      payload: { role: 'superuser' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });
});
