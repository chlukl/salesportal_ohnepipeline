/** Test helpers for the live integrations: mocked fetch (no network), live config, in-memory DB. */
import type { AppConfig } from '../src/config';
import { loadConfig } from '../src/config';
import { createDb, runMigrations, type DbHandle } from '../src/db/client';
import type { AdapterAuth, AdapterDeps } from '../src/integrations/types';
import { createLiveRuntime, type LiveRuntime } from '../src/integrations/live/runtime';
import { createLogger } from '../src/lib/logger';

export const DV = 'https://org.crm4.dynamics.com';
export const API = `${DV}/api/data/v9.2/`;
export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const TENANT = '11111111-1111-1111-1111-111111111111';
export const CLIENT = '22222222-2222-2222-2222-222222222222';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export type Route = (req: RecordedRequest) => FakeResponse | undefined;

/** fetch replacement: routes are tried in order; unmatched requests fail the test with 599. */
export function fakeFetch(routes: Route[]) {
  const calls: RecordedRequest[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = init.body == null ? '' : String(init.body);
    const req: RecordedRequest = { method: init.method ?? 'GET', url: input, headers, body };
    calls.push(req);
    for (const route of routes) {
      const r = route(req);
      if (!r) continue;
      const status = r.status ?? 200;
      const text = r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body));
      return new Response(status === 204 ? null : text, { status, headers: { 'content-type': 'application/json', ...r.headers } });
    }
    return new Response(JSON.stringify({ error: { code: 'unrouted' } }), { status: 599 });
  };
  return { fetch, calls };
}

/** Token endpoint route returning a fixed app token. */
export function tokenRoute(counter?: { n: number }): Route {
  return (req) => {
    if (!req.url.includes('/oauth2/v2.0/token')) return undefined;
    if (counter) counter.n++;
    const params = new URLSearchParams(req.body);
    return { body: { access_token: `tok-${params.get('grant_type')}-${counter?.n ?? 0}`, expires_in: 3600, token_type: 'Bearer' } };
  };
}

export function liveConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    PGLITE_DIR: 'memory://',
    AUTH_MODE: 'dev',
    INTEGRATIONS: 'mock',
    CRM_ADAPTER: 'live',
    CALENDAR_ADAPTER: 'live',
    MAIL_ADAPTER: 'live',
    DATAVERSE_URL: DV,
    ENTRA_TENANT_ID: TENANT,
    ENTRA_CLIENT_ID: CLIENT,
    ENTRA_CLIENT_SECRET: 'test-secret-value',
    GRAPH_ALLOWED_MAILBOXES: 'markus@kallysoft.ch,manuel@kallysoft.ch,nico@kallysoft.ch,lukas@kallysoft.ch',
    MAIL_TEST_RECIPIENT: 'test@kallysoft.ch',
    LOG_LEVEL: 'silent',
    ...env,
  });
}

export function testRuntime(config: AppConfig, fetch: (input: string, init: RequestInit) => Promise<Response>, sleeps: number[] = []): LiveRuntime {
  return createLiveRuntime(config, createLogger('silent'), {
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });
}

let dbHandle: DbHandle | null = null;
/** One migrated in-memory PGlite per test file. */
export async function testDb(config: AppConfig): Promise<DbHandle> {
  if (!dbHandle) {
    dbHandle = await createDb(config.db);
    await runMigrations(dbHandle);
  }
  return dbHandle;
}
export async function closeTestDb(): Promise<void> {
  await dbHandle?.close();
  dbHandle = null;
}

export function deps(config: AppConfig, db: DbHandle['db'], auth: AdapterAuth = { kind: 'system' }, now = new Date('2026-11-20T09:00:00Z')): AdapterDeps {
  return { config, db, log: createLogger('silent'), auth, now: () => now };
}

export const SYSTEM_ACTOR = { kind: 'system' as const, userId: null, displayName: 'system', crmUserId: null, email: null };
export const MARKUS_ACTOR = {
  kind: 'user' as const,
  userId: '33333333-3333-4333-8333-333333333333',
  displayName: 'Markus',
  crmUserId: '66666666-6666-4666-8666-666666666666',
  email: 'markus@kallysoft.ch',
};
