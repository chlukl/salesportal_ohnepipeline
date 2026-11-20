/**
 * /api/me – current user, roles, «Ansicht als», header counters.
 * «Ansicht als» only for real admins; effective roles = [viewAs]. Returning (DELETE) is always allowed for real admins,
 * even while viewing as a non-admin role (requireRealAdmin ignores viewAs).
 */
import { ROLES, type HeaderCounters, type MeResponse } from '@sales-portal/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireRealAdmin } from '../../auth/rbac';
import { setViewAs } from '../../auth/session';
import { adaptersFor } from '../../integrations';
import { audit } from '../../lib/audit';
import { buildMe, computeCounters } from './service';

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/', { config: requireAuth() }, async (request): Promise<MeResponse> => buildMe(request.auth!, app.config));

  app.put(
    '/view-as',
    { config: requireRealAdmin(), schema: { body: z.object({ role: z.enum(ROLES) }) } },
    async (request): Promise<MeResponse> => {
      const auth = request.auth!;
      const role = request.body.role;
      await setViewAs(app.db, auth.sessionIdHash, role);
      await audit(app.db, { actor: auth.actor, action: 'me.view_as', entity: 'session', entityId: auth.user.id, oldValue: auth.viewAs, newValue: role });
      return buildMe({ ...auth, viewAs: role, effectiveRoles: [role] }, app.config);
    },
  );

  app.delete('/view-as', { config: requireRealAdmin() }, async (request): Promise<MeResponse> => {
    const auth = request.auth!;
    await setViewAs(app.db, auth.sessionIdHash, null);
    if (auth.viewAs) {
      await audit(app.db, { actor: auth.actor, action: 'me.view_as', entity: 'session', entityId: auth.user.id, oldValue: auth.viewAs, newValue: null });
    }
    return buildMe({ ...auth, viewAs: null, effectiveRoles: [...auth.roles] }, app.config);
  });

  app.get('/counters', { config: requireAuth() }, async (request): Promise<HeaderCounters> =>
    computeCounters(app.ctx.counters, {
      config: app.config,
      db: app.db,
      auth: request.auth!,
      adapters: adaptersFor(request),
      log: request.log,
    }),
  );
};
