/**
 * /api/dashboard – Kennzahlen (INTENT 6.12). Rollen: sales, ai_specialist, admin – NIE coldcaller (also not while an
 * admin views as coldcaller: requireRoles checks the effective roles). Aggregates only, no personal lead data.
 */
import type { DashboardReport, WeeklyReportPreview } from '@sales-portal/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLESETS, requireRoles } from '../../auth/rbac';
import { adaptersFor } from '../../integrations';
import { forbidden } from '../../lib/errors';
import { previewWeeklyReport, sendWeeklyReport, type SendResult } from './report';
import { buildReport, getSummary } from './service';

const reportQuery = z.object({
  range: z.enum(['week', 'month', 'quarter']).default('week'),
  anchor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'ungültiges Datum')
    .optional(),
});

export const dashboardRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/summary', { config: requireRoles(...ROLESETS.dashboard) }, async (request) => getSummary(adaptersFor(request), app.ctx.now()));

  app.get(
    '/report',
    { config: requireRoles(...ROLESETS.dashboard), schema: { querystring: reportQuery } },
    async (request): Promise<DashboardReport> =>
      buildReport(app.db, adaptersFor(request), { range: request.query.range, anchor: request.query.anchor, now: app.ctx.now() }),
  );

  app.get(
    '/weekly-report/preview',
    { config: requireRoles(...ROLESETS.dashboard) },
    async (request): Promise<WeeklyReportPreview> => previewWeeklyReport(app.db, adaptersFor(request), app.ctx.now()),
  );

  // Send now (admin only; the regular send is the Monday job). Uses the system adapters like the job.
  app.post('/weekly-report/send', { config: requireRoles('admin') }, async (request): Promise<SendResult> => {
    const auth = request.auth!;
    if (!auth.isRealAdmin) throw forbidden();
    return sendWeeklyReport(app.db, app.adapters.system(), app.ctx.now(), {
      force: true,
      actor: { userId: auth.user.id, displayName: auth.user.displayName },
    });
  });
};
