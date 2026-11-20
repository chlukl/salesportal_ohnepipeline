/**
 * Global security hooks (non-encapsulated):
 * 1. onRoute: default-deny – every /api route must declare roles (or be an allowed public route), else startup fails.
 * 2. onRequest (/api only): load session → 401 without session → CSRF (Origin + token) for unsafe methods → roles → 403.
 */
import fp from 'fastify-plugin';
import { forbidden, unauthorized } from '../lib/errors';
import { assertCsrfToken, assertSameOrigin, isSafeMethod } from './csrf';
import { isAllowed, validateRouteSecurity } from './rbac';
import { loadSession, SESSION_COOKIE } from './session';

export class RouteSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteSecurityError';
  }
}

export const authPlugin = fp(
  async (app) => {
    app.decorateRequest('auth', null);

    app.addHook('onRoute', (route) => {
      const problem = validateRouteSecurity(route.url, route.config);
      if (problem) throw new RouteSecurityError(problem);
    });

    app.addHook('onRequest', async (request) => {
      const url = request.routeOptions.url;
      // Unknown route → not-found handler; non-API (static web) → no session needed.
      if (!url || !url.startsWith('/api')) return;
      const cfg = request.routeOptions.config ?? {};
      const unsafe = !isSafeMethod(request.method);

      const auth = await loadSession(app.db, app.config, request.cookies[SESSION_COOKIE]);
      request.auth = auth;

      if (cfg.public) {
        if (unsafe) assertSameOrigin(request, app.config.allowedOrigins);
        if (unsafe && auth && cfg.csrf !== 'origin-only') assertCsrfToken(request, auth.csrfToken);
        return;
      }

      // Defense in depth: routes are validated at registration, but never allow an undeclared route at runtime.
      if (!cfg.roles) throw forbidden();
      if (!auth) throw unauthorized();
      if (unsafe) {
        assertSameOrigin(request, app.config.allowedOrigins);
        assertCsrfToken(request, auth.csrfToken);
      }
      if (!isAllowed(auth, cfg.roles)) throw forbidden();
    });
  },
  { name: 'sales-portal-auth', dependencies: ['@fastify/cookie'] },
);
