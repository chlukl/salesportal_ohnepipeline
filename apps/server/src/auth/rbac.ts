/**
 * RBAC (ARCHITECTURE §5.4). Every route under /api declares its roles in the route config:
 *
 *   app.get('/x', { config: requireRoles('coldcaller', 'admin'), schema }, handler)
 *   app.get('/me', { config: requireAuth() }, handler)            // any logged-in user
 *   app.put('/me/view-as', { config: requireRealAdmin() }, …)     // real admin, ignores «Ansicht als»
 *   app.get('/health', { config: publicRoute() }, handler)        // only health + auth
 *
 * Default = deny: registering an /api route without a declaration throws at startup (see plugin.ts).
 * There is no implicit admin bypass – list `admin` explicitly where admins may act.
 */
import { ROLES, type Actor, type Role } from '@sales-portal/shared';

export type RoleRequirement = readonly Role[] | 'authenticated' | 'real_admin';

export interface RouteSecurityConfig {
  roles?: RoleRequirement;
  public?: boolean;
  /** Public unsafe endpoints without session (dev login): Origin/Sec-Fetch-Site is still enforced. */
  csrf?: 'origin-only';
}

export function requireRoles(...roles: Role[]): { roles: readonly Role[] } {
  if (roles.length === 0) throw new Error('requireRoles() needs at least one role');
  for (const r of roles) if (!ROLES.includes(r)) throw new Error(`Unknown role ${r}`);
  return { roles };
}

export function requireAuth(): { roles: 'authenticated' } {
  return { roles: 'authenticated' };
}

export function requireRealAdmin(): { roles: 'real_admin' } {
  return { roles: 'real_admin' };
}

export function publicRoute(options: { csrf?: 'origin-only' } = {}): { public: true; csrf?: 'origin-only' } {
  return { public: true, ...options };
}

/** Role sets used by several modules (ARCHITECTURE §4). */
export const ROLESETS = {
  all: ['coldcaller', 'sales', 'ai_specialist', 'admin'] as Role[],
  coldcall: ['coldcaller', 'admin'] as Role[],
  workspace: ['coldcaller', 'sales', 'ai_specialist', 'admin'] as Role[],
  dashboard: ['sales', 'ai_specialist', 'admin'] as Role[],
  admin: ['admin'] as Role[],
};

export interface RequestAuth {
  sessionIdHash: string;
  csrfToken: string;
  user: { id: string; email: string; displayName: string; crmUserId: string | null };
  /** Real roles of the user. */
  roles: Role[];
  /** Roles used for authorization: [viewAs] while «Ansicht als» is active (real admins only), else the real roles. */
  effectiveRoles: Role[];
  viewAs: Role | null;
  isRealAdmin: boolean;
  actor: Actor;
}

export function computeEffectiveRoles(realRoles: Role[], viewAs: Role | null): { effectiveRoles: Role[]; viewAs: Role | null } {
  const isRealAdmin = realRoles.includes('admin');
  if (viewAs && isRealAdmin) return { effectiveRoles: [viewAs], viewAs };
  return { effectiveRoles: [...realRoles], viewAs: null };
}

export function hasAnyRole(auth: Pick<RequestAuth, 'effectiveRoles'>, roles: readonly Role[]): boolean {
  return roles.some((r) => auth.effectiveRoles.includes(r));
}

/** Evaluate a route requirement against the request's auth. */
export function isAllowed(auth: RequestAuth, requirement: RoleRequirement): boolean {
  if (requirement === 'authenticated') return true;
  if (requirement === 'real_admin') return auth.isRealAdmin;
  return hasAnyRole(auth, requirement);
}

/** Only these API paths may be public (no session). Everything else needs a role declaration. */
export const PUBLIC_API_PREFIXES = ['/api/health', '/api/auth/'];

/** Validates a route config at registration time; returns an error message or null. */
export function validateRouteSecurity(url: string, config: RouteSecurityConfig | undefined): string | null {
  if (!url.startsWith('/api')) return null;
  if (config?.public === true) {
    return PUBLIC_API_PREFIXES.some((p) => url === p || url.startsWith(p))
      ? null
      : `Route ${url} must not be public (only ${PUBLIC_API_PREFIXES.join(', ')})`;
  }
  const roles = config?.roles;
  if (roles === 'authenticated' || roles === 'real_admin') return null;
  if (Array.isArray(roles) && roles.length > 0 && roles.every((r) => ROLES.includes(r))) return null;
  return `Route ${url} has no role declaration (use requireRoles/requireAuth/requireRealAdmin/publicRoute)`;
}
