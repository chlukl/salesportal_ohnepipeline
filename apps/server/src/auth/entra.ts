/**
 * Microsoft Entra ID login (ARCHITECTURE §5.1): OIDC Authorization Code + PKCE (S256), confidential client,
 * state + nonce, tokens only server-side (AES-256-GCM) for later On-Behalf-Of calls.
 *
 * Flow state (PKCE verifier, state, nonce, returnTo) is kept in a short-lived, encrypted, httpOnly cookie scoped to
 * /api/auth, so the login works with several API instances and needs no DB table. It is single-use (cleared in the callback).
 */
import * as oidc from 'openid-client';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import { userRoles, users } from '../db/schema';
import { DEMO_USERS } from '../db/seed/users';
import { audit } from '../lib/audit';
import { safeErrorMessage } from '../lib/logger';
import { decryptJson, deriveKey, encryptJson } from './crypto';
import { createSession, destroySessionByRawId, SESSION_COOKIE, setSessionCookie } from './session';
import { encryptTokens, type StoredTokens } from './tokens';

export const OIDC_FLOW_COOKIE = 'sp_oidc';
const FLOW_MAX_AGE_SEC = 600;

interface FlowState {
  verifier: string;
  state: string;
  nonce: string;
  returnTo: string;
  createdAt: number;
}

let oidcConfigPromise: Promise<oidc.Configuration> | null = null;

/** Cached OIDC discovery for the tenant (v2.0 endpoint). */
export function getOidcConfiguration(config: AppConfig): Promise<oidc.Configuration> {
  const entra = config.auth.entra;
  if (!entra) throw new Error('Entra is not configured');
  if (!oidcConfigPromise) {
    const issuer = new URL(`https://login.microsoftonline.com/${encodeURIComponent(entra.tenantId)}/v2.0`);
    oidcConfigPromise = oidc
      .discovery(issuer, entra.clientId, undefined, oidc.ClientSecretPost(entra.clientSecret))
      .catch((err: unknown) => {
        oidcConfigPromise = null; // retry on next login
        throw err;
      });
  }
  return oidcConfigPromise;
}

/** Only allow relative in-app paths as returnTo (no open redirects). */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!/^\/(?![/\\])[^\s]*$/.test(value) || value.startsWith('/api/')) return '/';
  return value.slice(0, 500);
}

function flowKey(config: AppConfig): Buffer {
  if (!config.auth.tokenEncKey) throw new Error('TOKEN_ENC_KEY not configured');
  return deriveKey(config.auth.tokenEncKey, 'oidc-flow');
}

function flowCookieOptions(config: AppConfig) {
  return { httpOnly: true, secure: config.isProd, sameSite: 'lax' as const, path: '/api/auth' };
}

/** GET /api/auth/login → redirect to Entra. */
export async function startLogin(request: FastifyRequest, reply: FastifyReply, config: AppConfig): Promise<void> {
  const entra = config.auth.entra;
  if (!entra) throw new Error('Entra is not configured');
  const oidcConfig = await getOidcConfiguration(config);
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const returnTo = safeReturnTo((request.query as Record<string, unknown> | undefined)?.returnTo);
  const flow: FlowState = { verifier, state, nonce, returnTo, createdAt: Date.now() };
  reply.setCookie(OIDC_FLOW_COOKIE, encryptJson(flowKey(config), flow), { ...flowCookieOptions(config), maxAge: FLOW_MAX_AGE_SEC });
  const url = oidc.buildAuthorizationUrl(oidcConfig, {
    redirect_uri: entra.redirectUri,
    scope: entra.scopes.join(' '),
    response_type: 'code',
    response_mode: 'query',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  reply.redirect(url.href, 302);
}

interface EntraClaims {
  oid?: string;
  tid?: string;
  sub?: string;
  preferred_username?: string;
  email?: string;
  upn?: string;
  name?: string;
  /** Optional claim: 0 = member, 1 = guest. */
  acct?: number | string;
  /** Identity provider – only present when it differs from the token issuer (B2B guests, MSA). */
  idp?: string;
}

/** Login refused for a known reason (logged as `reason`, user sees the generic login error). */
export class EntraLoginError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'EntraLoginError';
  }
}

const DEMO_USER_IDS = new Set(DEMO_USERS.map((u) => u.id));
const SIGN_IN_NAME_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * B2B guest / external account (not a member of our tenant). Guests are never linked to a pre-provisioned portal user
 * and never get the bootstrap admin role – their sign-in name / mail is chosen outside our tenant.
 */
export function isGuestAccount(claims: EntraClaims, tenantId: string): boolean {
  if (claims.acct === 1 || claims.acct === '1') return true;
  if (typeof claims.idp === 'string' && claims.idp && !claims.idp.toLowerCase().includes(tenantId.toLowerCase())) return true;
  const upn = (claims.upn ?? claims.preferred_username ?? '').toLowerCase();
  return upn.includes('#ext#');
}

/**
 * Sign-in name used to link a first login to a pre-created portal user: the UPN (`preferred_username` / `upn`),
 * which only tenant admins can set and which is unique in the tenant. Never the `email` claim – that comes from the
 * editable mail attribute and is not verified.
 */
export function signInName(claims: EntraClaims): string | null {
  const v = (claims.preferred_username ?? claims.upn ?? '').trim().toLowerCase();
  return SIGN_IN_NAME_RE.test(v) ? v : null;
}

async function hasActiveAdmin(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.role, 'admin'), eq(users.isActive, true)))
    .limit(1);
  return !!row;
}

/**
 * Find the portal user for the Entra identity. Identity = `oid` (the caller has checked `tid`). A first login links to a
 * pre-created user with the same UPN (members only, never a demo user, never a user linked to another oid); unknown
 * users are created without roles. The bootstrap admin role is granted only on the first login of that identity or
 * while no active admin exists – a role revoked in the portal does not come back at the next sign-in.
 */
export async function upsertUser(db: Db, config: AppConfig, claims: EntraClaims): Promise<{ id: string; isActive: boolean; displayName: string }> {
  const oid = claims.oid?.trim();
  if (!oid) throw new EntraLoginError('missing_oid');
  const name = signInName(claims);
  if (!name) throw new EntraLoginError('missing_sign_in_name');
  const guest = isGuestAccount(claims, config.auth.entra?.tenantId ?? '');
  const displayName = (claims.name?.trim() || name).slice(0, 120);

  let firstLogin = false;
  let [user] = await db.select().from(users).where(eq(users.entraOid, oid));
  if (!user) {
    firstLogin = true;
    const [existing] = await db.select().from(users).where(sql`lower(${users.email}) = ${name}`);
    if (existing) {
      if (guest) throw new EntraLoginError('guest_link_refused');
      if (existing.entraOid) throw new EntraLoginError('already_linked_to_other_account');
      if (DEMO_USER_IDS.has(existing.id)) throw new EntraLoginError('demo_user_not_linkable');
      [user] = await db.update(users).set({ entraOid: oid, updatedAt: new Date() }).where(eq(users.id, existing.id)).returning();
    } else {
      [user] = await db.insert(users).values({ email: name, displayName, entraOid: oid }).returning();
    }
  }
  await db.update(users).set({ lastLoginAt: new Date(), displayName }).where(eq(users.id, user.id));

  if (!guest && config.auth.bootstrapAdminEmails.includes(name) && (firstLogin || !(await hasActiveAdmin(db)))) {
    const [hasAdmin] = await db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, user.id), eq(userRoles.role, 'admin')));
    if (!hasAdmin) {
      await db.insert(userRoles).values({ userId: user.id, role: 'admin' }).onConflictDoNothing();
      await audit(db, { actor: 'system', action: 'admin.role_grant', entity: 'user', entityId: user.id, field: 'role', newValue: 'admin', meta: { reason: 'bootstrap' } });
    }
  }
  return { id: user.id, isActive: user.isActive, displayName };
}

/** GET /api/auth/callback → validate code (state, nonce, PKCE), create session, redirect into the app. */
export async function finishLogin(request: FastifyRequest, reply: FastifyReply, db: Db, config: AppConfig): Promise<void> {
  const entra = config.auth.entra;
  const fail = (reason: string, err?: unknown) => {
    // Never the raw message: a failed DB query (upsertUser, createSession) carries the bound values (e-mail, CSRF token).
    request.log.warn({ reason, err: err instanceof Error ? { name: err.name, message: safeErrorMessage(err) } : undefined }, 'entra login failed');
    reply.clearCookie(OIDC_FLOW_COOKIE, flowCookieOptions(config));
    reply.redirect('/login?fehler=anmeldung', 302);
  };
  if (!entra) return fail('not_configured');

  const rawFlow = request.cookies[OIDC_FLOW_COOKIE];
  if (!rawFlow) return fail('missing_flow_cookie');
  let flow: FlowState;
  try {
    flow = decryptJson<FlowState>(flowKey(config), rawFlow);
  } catch (err) {
    return fail('invalid_flow_cookie', err);
  }
  reply.clearCookie(OIDC_FLOW_COOKIE, flowCookieOptions(config));
  if (Date.now() - flow.createdAt > FLOW_MAX_AGE_SEC * 1000) return fail('flow_expired');

  try {
    const oidcConfig = await getOidcConfiguration(config);
    // Must equal the registered redirect URI + the query Entra sent back.
    const currentUrl = new URL(request.url, entra.redirectUri);
    const redirect = new URL(entra.redirectUri);
    currentUrl.protocol = redirect.protocol;
    currentUrl.host = redirect.host;
    currentUrl.pathname = redirect.pathname;

    const tokens = await oidc.authorizationCodeGrant(oidcConfig, currentUrl, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const claims = (tokens.claims() ?? {}) as EntraClaims;
    if (claims.tid !== entra.tenantId) return fail('wrong_tenant');

    const user = await upsertUser(db, config, claims);
    if (!user.isActive) return fail('user_inactive');

    const stored: StoredTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      idToken: tokens.id_token ?? null,
      expiresAt: typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : null,
      scope: tokens.scope ?? null,
    };
    // Rotation: drop a pre-existing session of this browser.
    await destroySessionByRawId(db, config, request.cookies[SESSION_COOKIE]);
    const session = await createSession(db, config, {
      userId: user.id,
      method: 'entra',
      userAgent: request.headers['user-agent'] ?? null,
      tokensEnc: encryptTokens(config, stored),
      tokenExpiresAt: stored.expiresAt ? new Date(stored.expiresAt) : null,
    });
    setSessionCookie(reply, config, session);
    await audit(db, { actor: { userId: user.id, displayName: user.displayName }, action: 'auth.login', entity: 'user', entityId: user.id, meta: { method: 'entra' } });
    reply.redirect(safeReturnTo(flow.returnTo), 302);
  } catch (err) {
    if (err instanceof EntraLoginError) return fail(err.reason);
    return fail('token_exchange', err);
  }
}

/** URL to end the Entra session after the portal session was deleted. */
export async function endSessionUrl(config: AppConfig, idToken: string | null): Promise<string> {
  const entra = config.auth.entra;
  if (!entra) return '/login';
  try {
    const oidcConfig = await getOidcConfiguration(config);
    const params: Record<string, string> = { post_logout_redirect_uri: entra.postLogoutRedirectUri };
    if (idToken) params.id_token_hint = idToken;
    return oidc.buildEndSessionUrl(oidcConfig, params).href;
  } catch {
    return '/login';
  }
}
