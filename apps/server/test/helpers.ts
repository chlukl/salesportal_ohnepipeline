/** Test helpers: in-memory PGlite app with dev login. */
import { buildApp, type App } from '../src/app';
import { loadConfig } from '../src/config';
import { createContext, type AppContext } from '../src/context';
import { DEMO_USERS } from '../src/db/seed/users';
import { createLogger } from '../src/lib/logger';
import type { PortalModule } from '../src/modules/registry';

export const ORIGIN = 'http://localhost:5173';

export interface TestApp {
  app: App;
  ctx: AppContext;
  /** Dev login (cached per user – the login endpoint is rate-limited to 10/min; `fresh` forces a new session). */
  login(user: 'lukas' | 'markus' | 'manuel' | 'nico', options?: { fresh?: boolean }): Promise<Session>;
  close(): Promise<void>;
}

export interface Session {
  cookie: string;
  csrf: string;
  /** Headers for unsafe requests (cookie + origin + csrf token). */
  headers: Record<string, string>;
}

export async function createTestApp(
  options: { env?: Record<string, string>; demoCrm?: boolean; modules?: PortalModule[] } = {},
): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    PGLITE_DIR: 'memory://',
    AUTH_MODE: 'dev',
    INTEGRATIONS: 'mock',
    LOG_LEVEL: 'silent',
    ...options.env,
  });
  const ctx = await createContext(config, {
    log: createLogger('silent'),
    seed: { skipDemoCrm: !options.demoCrm },
    modules: options.modules,
  });
  let app: App;
  try {
    app = await buildApp(ctx);
    await app.ready();
  } catch (err) {
    await ctx.close();
    throw err;
  }

  const cache = new Map<string, Session>();
  return {
    app,
    ctx,
    async login(key, loginOptions = {}) {
      const cached = cache.get(key);
      if (cached && !loginOptions.fresh) return cached;
      const user = DEMO_USERS.find((u) => u.key === key)!;
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/dev-login',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: { userId: user.id },
      });
      if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
      const setCookie = res.headers['set-cookie'];
      const raw = (Array.isArray(setCookie) ? setCookie : [setCookie ?? '']).find((c) => c.startsWith('sp_sid='))!;
      const cookie = raw.split(';')[0];
      const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
      const csrf = me.json().csrfToken as string;
      const session = { cookie, csrf, headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrf } };
      if (!loginOptions.fresh) cache.set(key, session);
      return session;
    },
    async close() {
      await app.close();
      await ctx.close();
    },
  };
}
