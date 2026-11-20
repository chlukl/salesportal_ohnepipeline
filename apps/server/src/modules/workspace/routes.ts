/**
 * /api/workspace – Lead-Arbeitsplatz: Firma, Personen der Firma, Verlauf, Spickzettel (INTENT 6.2, 6.17).
 * OWNER: coldcall implementer.
 *
 *   GET /api/workspace/:leadId → WorkspaceData (lead, persons, timeline, campaignMails, openTasks, objections, useCases,
 *                                callReason, notReached, contactPauseUntil, activeCall, canCall)
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLESETS, requireRoles } from '../../auth/rbac';
import { adaptersFor } from '../../integrations';
import { crmId } from '../../lib/zod';
import { loadWorkspace } from './service';

export const workspaceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/:leadId',
    { config: requireRoles(...ROLESETS.workspace), schema: { params: z.object({ leadId: crmId }) } },
    async (request) => loadWorkspace(adaptersFor(request), request.params.leadId, { db: app.db, auth: request.auth!, now: app.ctx.now() }),
  );
};
