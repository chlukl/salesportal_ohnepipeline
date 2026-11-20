/**
 * Entra token acquisition for the live adapters (INTENT 8).
 *
 * - **Delegated** (user actions, `auth.kind === 'user'`): the encrypted tokens of the portal session (auth/tokens.ts)
 *   are exchanged for a token of the target resource:
 *     - `obo`: On-Behalf-Of (jwt-bearer grant) – when the session access token was issued for the portal's own API
 *       (`aud` = client id or `api://<client id>`, i.e. ENTRA_SCOPES contains `api://<client id>/<scope>`).
 *     - `refresh_token`: refresh-token grant for the target scope (what MSAL does for a confidential web app; the
 *       login token is a Graph token, which Entra does not accept as OBO assertion).
 *     - `auto` (default): `obo` when possible, else `refresh_token`.
 *   Rotated refresh tokens are written back to the session (encrypted). `invalid_grant` / `interaction_required`
 *   → `ReauthRequiredError` (401 «Bitte neu anmelden»).
 * - **App-only** (background jobs, `auth.kind === 'system'`): client credentials with secret or certificate
 *   (client assertion, RS256 + x5t / x5t#S256).
 * - In-memory cache per (identity, resource) with expiry (5 min skew), single-flight per key. Tokens are never logged.
 */
import { createHash, createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { AppConfig } from '../../config';
import type { Db } from '../../db/client';
import { loadSessionTokens, saveSessionTokens, type StoredTokens } from '../../auth/tokens';
import type { Logger } from '../../lib/logger';
import type { AdapterAuth } from '../types';
import { ReauthRequiredError, upstreamError } from './errors';
import { upstreamCodeOf, type HttpClient } from './http';

export type TokenResource = 'dataverse' | 'graph';

/** Delegated Graph permissions requested for user actions. */
export const GRAPH_DELEGATED_SCOPES = ['Calendars.ReadWrite.Shared', 'Mail.Send', 'User.Read'];

const EXPIRY_SKEW_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 1000;
const REAUTH_ERRORS = new Set(['invalid_grant', 'interaction_required', 'consent_required', 'login_required']);

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
}

/** Decode the payload of a JWT without verifying it (only used to read `aud`/`exp` of our own session token). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

/** DER bytes of the first certificate in a PEM string. */
export function pemToDer(pem: string): Buffer {
  const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
  if (!m) throw new Error('no certificate in PEM');
  return Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
}

export class EntraTokenService {
  private readonly cache = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<string>>();
  private assertionKey: { key: KeyObject; x5t: string; x5tS256: string } | null = null;
  private warnedDevFallback = false;

  constructor(
    private readonly config: AppConfig,
    private readonly http: HttpClient,
    private readonly log: Pick<Logger, 'debug' | 'warn' | 'info'>,
    private readonly now: () => number = Date.now,
  ) {}

  get tokenEndpoint(): string {
    const { authorityHost, tenantId } = this.config.live;
    return `https://${authorityHost}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  }

  /** Resource origin, e.g. `https://org.crm4.dynamics.com` or `https://graph.microsoft.com`. */
  resourceOrigin(resource: TokenResource): string {
    if (resource === 'dataverse') {
      if (!this.config.dataverseUrl) throw new Error('DATAVERSE_URL not configured');
      return new URL(this.config.dataverseUrl).origin;
    }
    return new URL(this.config.graphBaseUrl).origin;
  }

  scopesFor(resource: TokenResource, kind: AdapterAuth['kind']): string[] {
    const origin = this.resourceOrigin(resource);
    if (kind === 'system') return [`${origin}/.default`];
    return resource === 'dataverse' ? [`${origin}/user_impersonation`] : GRAPH_DELEGATED_SCOPES.map((s) => `${origin}/${s}`);
  }

  /** Drop cached tokens (tests, logout). */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  /** Access token for `resource` acting as `auth`. */
  async getToken(resource: TokenResource, auth: AdapterAuth, db: Db): Promise<string> {
    if (auth.kind === 'user' && this.config.auth.mode === 'dev') {
      // Dev login has no Entra session → use the app registration (sandbox tests only; production forbids AUTH_MODE=dev).
      if (!this.warnedDevFallback) {
        this.warnedDevFallback = true;
        this.log.warn({ resource }, 'live adapters with AUTH_MODE=dev: user actions use the app registration (no delegated identity)');
      }
      return this.getToken(resource, { kind: 'system' }, db);
    }
    const identity = auth.kind === 'system' ? 'app' : `user:${auth.sessionIdHash ?? 'none'}`;
    const key = `${identity}|${resource}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > this.now()) return cached.token;

    const running = this.inflight.get(key);
    if (running) return running;
    const promise = (async () => {
      const result =
        auth.kind === 'system' ? await this.acquireAppToken(resource) : await this.acquireDelegatedToken(resource, auth, db);
      this.remember(key, result);
      return result.token;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private remember(key: string, value: CachedToken): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Client authentication (secret or certificate)
  // -------------------------------------------------------------------------------------------------------------------

  private clientAuthParams(): Record<string, string> {
    const live = this.config.live;
    if (live.clientCertificate) {
      return {
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: this.clientAssertion(),
      };
    }
    if (live.clientSecret) return { client_secret: live.clientSecret };
    throw new Error('no client credential configured');
  }

  /** Signed client assertion (RFC 7523) for certificate credentials. */
  clientAssertion(): string {
    const cert = this.config.live.clientCertificate;
    if (!cert) throw new Error('no client certificate configured');
    if (!this.assertionKey) {
      // Thumbprint = hash of the certificate's DER bytes (config validation already parsed it as X.509).
      const der = pemToDer(cert.certPem);
      this.assertionKey = {
        key: createPrivateKey(cert.keyPem),
        x5t: b64url(createHash('sha1').update(der).digest()),
        x5tS256: b64url(createHash('sha256').update(der).digest()),
      };
    }
    const nowSec = Math.floor(this.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', x5t: this.assertionKey.x5t, 'x5t#S256': this.assertionKey.x5tS256 };
    const payload = {
      aud: this.tokenEndpoint,
      iss: this.config.live.clientId,
      sub: this.config.live.clientId,
      jti: randomUUID(),
      nbf: nowSec - 60,
      iat: nowSec,
      exp: nowSec + 600,
    };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = sign('sha256', Buffer.from(input), this.assertionKey.key);
    return `${input}.${b64url(signature)}`;
  }

  private async postToken(params: Record<string, string>, delegated: boolean): Promise<TokenEndpointResponse & { access_token: string }> {
    const body = new URLSearchParams({ client_id: this.config.live.clientId, ...this.clientAuthParams(), ...params });
    const res = await this.http.send({
      service: 'entra',
      method: 'POST',
      url: this.tokenEndpoint,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      retry: 'idempotent', // token requests have no side effects
    });
    const json = (() => {
      try {
        return res.json<TokenEndpointResponse>();
      } catch {
        return {} as TokenEndpointResponse;
      }
    })();
    if (res.status === 200 && typeof json.access_token === 'string') return json as TokenEndpointResponse & { access_token: string };
    const code = upstreamCodeOf(res);
    this.log.warn({ status: res.status, error: code, grant: params.grant_type, delegated }, 'entra token request failed');
    if (delegated && code && REAUTH_ERRORS.has(code)) throw new ReauthRequiredError();
    throw upstreamError('entra', res.status === 400 || res.status === 401 ? 502 : res.status, code);
  }

  private expiresAt(json: TokenEndpointResponse): number {
    const sec = Number(json.expires_in ?? 3600);
    return this.now() + (Number.isFinite(sec) && sec > 0 ? sec : 3600) * 1000;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // App-only
  // -------------------------------------------------------------------------------------------------------------------

  private async acquireAppToken(resource: TokenResource): Promise<CachedToken> {
    const json = await this.postToken({ grant_type: 'client_credentials', scope: this.scopesFor(resource, 'system').join(' ') }, false);
    return { token: json.access_token, expiresAt: this.expiresAt(json) };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Delegated
  // -------------------------------------------------------------------------------------------------------------------

  /** Is the session access token issued for the portal's own API (→ usable as OBO assertion)? */
  private isOwnApiToken(accessToken: string): boolean {
    const aud = decodeJwtPayload(accessToken)?.aud;
    const clientId = this.config.live.clientId;
    return typeof aud === 'string' && (aud === clientId || aud === `api://${clientId}`);
  }

  private tokenExpired(accessToken: string, expiresAt: number | null): boolean {
    const exp = decodeJwtPayload(accessToken)?.exp;
    const at = typeof exp === 'number' ? exp * 1000 : expiresAt;
    return at == null || at - 60_000 <= this.now();
  }

  private async acquireDelegatedToken(resource: TokenResource, auth: Extract<AdapterAuth, { kind: 'user' }>, db: Db): Promise<CachedToken> {
    if (!auth.sessionIdHash) throw new ReauthRequiredError();
    let stored = await loadSessionTokens(db, this.config, auth.sessionIdHash);
    if (!stored) throw new ReauthRequiredError();
    const scopes = this.scopesFor(resource, 'user');
    const flow = this.config.live.delegatedFlow;
    const useObo = flow === 'obo' || (flow === 'auto' && this.isOwnApiToken(stored.accessToken));

    if (useObo) {
      if (this.tokenExpired(stored.accessToken, stored.expiresAt)) {
        stored = await this.refreshSessionToken(stored, auth.sessionIdHash, db);
      }
      const json = await this.postToken(
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          requested_token_use: 'on_behalf_of',
          assertion: stored.accessToken,
          scope: scopes.join(' '),
        },
        true,
      );
      return { token: json.access_token, expiresAt: this.expiresAt(json) };
    }

    if (!stored.refreshToken) throw new ReauthRequiredError();
    const json = await this.postToken(
      { grant_type: 'refresh_token', refresh_token: stored.refreshToken, scope: [...scopes, 'offline_access'].join(' ') },
      true,
    );
    if (json.refresh_token && json.refresh_token !== stored.refreshToken) {
      await saveSessionTokens(db, this.config, auth.sessionIdHash, { ...stored, refreshToken: json.refresh_token });
    }
    return { token: json.access_token, expiresAt: this.expiresAt(json) };
  }

  /** Refresh the session's own access token (OBO assertion) with its refresh token; persists the new tokens. */
  private async refreshSessionToken(stored: StoredTokens, sessionIdHash: string, db: Db): Promise<StoredTokens> {
    if (!stored.refreshToken) throw new ReauthRequiredError();
    const scope = stored.scope ?? this.config.auth.entra?.scopes.join(' ') ?? 'openid offline_access';
    const json = await this.postToken({ grant_type: 'refresh_token', refresh_token: stored.refreshToken, scope }, true);
    const next: StoredTokens = {
      ...stored,
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? stored.refreshToken,
      expiresAt: this.expiresAt(json),
      scope: json.scope ?? stored.scope,
    };
    await saveSessionTokens(db, this.config, sessionIdHash, next);
    return next;
  }
}
