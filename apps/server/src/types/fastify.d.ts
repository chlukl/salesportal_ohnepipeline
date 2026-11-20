import 'fastify';
import type { AppContext } from '../context';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import type { AdapterFactory } from '../integrations';
import type { RequestAuth, RouteSecurityConfig } from '../auth/rbac';

declare module 'fastify' {
  // Route config: `config: requireRoles('admin')` etc. (auth/rbac.ts)
  interface FastifyContextConfig extends RouteSecurityConfig {}

  interface FastifyRequest {
    /** Authenticated session (null on public routes without session). */
    auth: RequestAuth | null;
  }

  interface FastifyInstance {
    ctx: AppContext;
    config: AppConfig;
    db: Db;
    adapters: AdapterFactory;
  }
}
