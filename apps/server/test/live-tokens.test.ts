import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredTokens } from '../src/auth/tokens';
import type { AppConfig } from '../src/config';
import type { Db } from '../src/db/client';
import { ReauthRequiredError } from '../src/integrations/live/errors';
import { HttpClient } from '../src/integrations/live/http';
import { EntraTokenService } from '../src/integrations/live/tokens';
import { CLIENT, DV, fakeFetch, liveConfig, TENANT, type RecordedRequest } from './live-helpers';

// In-memory session token store instead of the encrypted DB column.
const store = new Map<string, StoredTokens>();
const saved: { hash: string; tokens: StoredTokens }[] = [];
vi.mock('../src/auth/tokens', () => ({
  loadSessionTokens: async (_db: unknown, _config: unknown, hash: string) => store.get(hash) ?? null,
  saveSessionTokens: async (_db: unknown, _config: unknown, hash: string, tokens: StoredTokens) => {
    saved.push({ hash, tokens });
    store.set(hash, tokens);
  },
}));

const db = {} as Db;
const log = { debug: () => {}, warn: () => {}, info: () => {} };
const jwt = (payload: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

function service(config: AppConfig, respond: (req: RecordedRequest, params: URLSearchParams) => { status?: number; body: unknown }, clock = { now: Date.parse('2026-11-20T09:00:00Z') }) {
  const ff = fakeFetch([
    (req) => {
      const params = new URLSearchParams(req.body);
      return respond(req, params);
    },
  ]);
  const http = new HttpClient({ fetch: ff.fetch, sleep: async () => {} });
  return { svc: new EntraTokenService(config, http, log, () => clock.now), calls: ff.calls, clock };
}

const user = (hash: string) => ({ kind: 'user' as const, userId: 'u1', email: 'markus@kallysoft.ch', sessionIdHash: hash });

beforeEach(() => {
  store.clear();
  saved.length = 0;
});

describe('app-only tokens (client credentials)', () => {
  it('requests /.default for the resource with the client secret and caches until shortly before expiry', async () => {
    const config = liveConfig();
    const { svc, calls, clock } = service(config, () => ({ body: { access_token: `app-${Math.random()}`, expires_in: 3600 } }));
    const t1 = await svc.getToken('dataverse', { kind: 'system' }, db);
    const t2 = await svc.getToken('dataverse', { kind: 'system' }, db);
    expect(t1).toBe(t2);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    const params = new URLSearchParams(calls[0].body);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('scope')).toBe(`${DV}/.default`);
    expect(params.get('client_id')).toBe(CLIENT);
    expect(params.get('client_secret')).toBe('test-secret-value');

    // Graph is a separate cache entry.
    await svc.getToken('graph', { kind: 'system' }, db);
    expect(new URLSearchParams(calls[1].body).get('scope')).toBe('https://graph.microsoft.com/.default');

    // 56 minutes later (inside the 5 min skew) → new token.
    clock.now += 56 * 60_000;
    const t3 = await svc.getToken('dataverse', { kind: 'system' }, db);
    expect(t3).not.toBe(t1);
    expect(calls).toHaveLength(3);
  });

  it('single-flight: concurrent callers share one token request', async () => {
    const { svc, calls } = service(liveConfig(), () => ({ body: { access_token: 'app', expires_in: 3600 } }));
    const tokens = await Promise.all([1, 2, 3].map(() => svc.getToken('graph', { kind: 'system' }, db)));
    expect(new Set(tokens)).toEqual(new Set(['app']));
    expect(calls).toHaveLength(1);
  });

  it('signs a client assertion (RS256, x5t) when a certificate is configured', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fakeDer = Buffer.from('not-a-real-certificate-der');
    const base = liveConfig();
    const config: AppConfig = {
      ...base,
      live: {
        ...base.live,
        clientSecret: null,
        clientCertificate: {
          certPem: `-----BEGIN CERTIFICATE-----\n${fakeDer.toString('base64')}\n-----END CERTIFICATE-----`,
          keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        },
      },
    };
    const { svc, calls } = service(config, () => ({ body: { access_token: 'cert-app', expires_in: 3600 } }));
    await svc.getToken('dataverse', { kind: 'system' }, db);
    const params = new URLSearchParams(calls[0].body);
    expect(params.get('client_secret')).toBeNull();
    expect(params.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    const [h, p, s] = (params.get('client_assertion') ?? '').split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(header.alg).toBe('RS256');
    expect(header.x5t).toBe(createHash('sha1').update(fakeDer).digest('base64url'));
    expect(payload).toMatchObject({ iss: CLIENT, sub: CLIENT, aud: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token` });
    expect(payload.exp - payload.iat).toBe(600);
    expect(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });
});

describe('delegated tokens (On-Behalf-Of / refresh token)', () => {
  const entraConfig = () =>
    liveConfig({ AUTH_MODE: 'entra', TOKEN_ENC_KEY: Buffer.alloc(32, 9).toString('base64'), PUBLIC_URL: 'http://localhost:5173' });

  it('refresh-token flow for a Graph login token: requests user_impersonation, persists the rotated refresh token, caches per session', async () => {
    store.set('s1', { accessToken: jwt({ aud: '00000003-0000-0000-c000-000000000000', exp: 9e9 }), refreshToken: 'rt-1', idToken: null, expiresAt: null, scope: null });
    const { svc, calls } = service(entraConfig(), (_req, params) => ({ body: { access_token: `dv-${params.get('refresh_token')}`, refresh_token: 'rt-2', expires_in: 3600 } }));
    const token = await svc.getToken('dataverse', user('s1'), db);
    expect(token).toBe('dv-rt-1');
    const params = new URLSearchParams(calls[0].body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('scope')).toBe(`${DV}/user_impersonation offline_access`);
    expect(saved).toHaveLength(1);
    expect(saved[0].tokens.refreshToken).toBe('rt-2');
    // Cached for the same session …
    expect(await svc.getToken('dataverse', user('s1'), db)).toBe('dv-rt-1');
    expect(calls).toHaveLength(1);
    // … but never shared with another session.
    store.set('s2', { accessToken: 'x', refreshToken: 'rt-other', idToken: null, expiresAt: null, scope: null });
    expect(await svc.getToken('dataverse', user('s2'), db)).toBe('dv-rt-other');
    expect(calls).toHaveLength(2);
  });

  it('requests the delegated Graph scopes', async () => {
    store.set('s1', { accessToken: 'graph-login', refreshToken: 'rt', idToken: null, expiresAt: null, scope: null });
    const { svc, calls } = service(entraConfig(), () => ({ body: { access_token: 'g', expires_in: 3600 } }));
    await svc.getToken('graph', user('s1'), db);
    expect(new URLSearchParams(calls[0].body).get('scope')).toBe(
      'https://graph.microsoft.com/Calendars.ReadWrite.Shared https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access',
    );
  });

  it('uses On-Behalf-Of when the session token was issued for the portal API', async () => {
    const assertion = jwt({ aud: `api://${CLIENT}`, exp: Date.parse('2026-11-20T10:00:00Z') / 1000 });
    store.set('s1', { accessToken: assertion, refreshToken: 'rt', idToken: null, expiresAt: null, scope: null });
    const { svc, calls } = service(entraConfig(), () => ({ body: { access_token: 'obo-dv', expires_in: 3600 } }));
    expect(await svc.getToken('dataverse', user('s1'), db)).toBe('obo-dv');
    const params = new URLSearchParams(calls[0].body);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(params.get('requested_token_use')).toBe('on_behalf_of');
    expect(params.get('assertion')).toBe(assertion);
    expect(params.get('scope')).toBe(`${DV}/user_impersonation`);
  });

  it('refreshes an expired OBO assertion first and stores the new session token', async () => {
    const expired = jwt({ aud: CLIENT, exp: Date.parse('2026-11-20T08:00:00Z') / 1000 });
    const fresh = jwt({ aud: CLIENT, exp: Date.parse('2026-11-20T10:00:00Z') / 1000 });
    store.set('s1', { accessToken: expired, refreshToken: 'rt', idToken: null, expiresAt: null, scope: `api://${CLIENT}/access_as_user offline_access` });
    const { svc, calls } = service(entraConfig(), (_req, params) =>
      params.get('grant_type') === 'refresh_token'
        ? { body: { access_token: fresh, refresh_token: 'rt-new', expires_in: 3600 } }
        : { body: { access_token: `obo-for-${params.get('assertion') === fresh}`, expires_in: 3600 } },
    );
    expect(await svc.getToken('graph', user('s1'), db)).toBe('obo-for-true');
    expect(calls.map((c) => new URLSearchParams(c.body).get('grant_type'))).toEqual(['refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer']);
    expect(new URLSearchParams(calls[0].body).get('scope')).toBe(`api://${CLIENT}/access_as_user offline_access`);
    expect(saved[0].tokens).toMatchObject({ accessToken: fresh, refreshToken: 'rt-new' });
  });

  it('invalid_grant / missing session tokens → «Bitte neu anmelden» (401)', async () => {
    store.set('s1', { accessToken: 'x', refreshToken: 'revoked', idToken: null, expiresAt: null, scope: null });
    const { svc } = service(entraConfig(), () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70000 secret details' } }));
    const err = await svc.getToken('dataverse', user('s1'), db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReauthRequiredError);
    expect((err as ReauthRequiredError).statusCode).toBe(401);
    expect((err as Error).message).not.toContain('AADSTS');
    await expect(svc.getToken('dataverse', user('unknown'), db)).rejects.toBeInstanceOf(ReauthRequiredError);
    await expect(svc.getToken('dataverse', { ...user('x'), sessionIdHash: null }, db)).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it('dev login (no Entra session) falls back to the app registration', async () => {
    const { svc, calls } = service(liveConfig(), () => ({ body: { access_token: 'app', expires_in: 3600 } }));
    expect(await svc.getToken('dataverse', user('s1'), db)).toBe('app');
    expect(new URLSearchParams(calls[0].body).get('grant_type')).toBe('client_credentials');
  });
});
