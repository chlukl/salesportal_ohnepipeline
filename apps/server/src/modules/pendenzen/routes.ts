/**
 * /api/pendenzen – Startseite für alle Rollen: Aufgaben, Termine, Briefings, Absagen, unabgeschlossene Anrufe,
 * Analysen zur Freigabe, Freigaben, Fehler (INTENT 6.16). Fremde Pendenzen nur für Admins (403 sonst).
 */
import type { PendenzenResponse, PendenzPerson } from '@sales-portal/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLESETS, requireRealAdmin, requireRoles } from '../../auth/rbac';
import { adaptersFor } from '../../integrations';
import { crmId, csv, isoDateTime } from '../../lib/zod';
import { PENDENZ_DUES, PENDENZ_KINDS } from './rules';
import {
  completeTask,
  createSavedFilter,
  deleteSavedFilter,
  listPendenzen,
  listPersons,
  listSavedFilters,
  rescheduleTask,
  setPendenzState,
  updateSavedFilter,
} from './service';

const ORIGINS = ['coldcall', 'campaign', 'other'] as const;
const STATUSES = ['open', 'done', 'all'] as const;

/** Filter as stored in saved filters (JSON body). */
export const PendenzFilterSchema = z
  .object({
    kinds: z.array(z.enum(PENDENZ_KINDS as [string, ...string[]])).max(20).optional(),
    due: z.array(z.enum(PENDENZ_DUES as [string, ...string[]])).max(10).optional(),
    userId: z.string().uuid().optional(),
    company: z.string().max(100).optional(),
    origins: z.array(z.enum(ORIGINS)).max(5).optional(),
    status: z.enum(STATUSES).optional(),
  })
  .strict();

/** Same filter as query string (`?kinds=task,booking&due=today`). */
const PendenzQuerySchema = z.object({
  kinds: csv(z.enum(PENDENZ_KINDS as [string, ...string[]]), 20),
  due: csv(z.enum(PENDENZ_DUES as [string, ...string[]]), 10),
  userId: z.string().uuid().optional(),
  company: z.string().max(100).optional(),
  origins: csv(z.enum(ORIGINS), 5),
  status: z.enum(STATUSES).optional(),
});

const ITEM_KEY = z.string().regex(/^(booking|briefing|cancellation|error|notification|campaign_reply):[A-Za-z0-9-]{1,100}$/, 'ungültige Pendenz');

export const pendenzenRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/',
    { config: requireRoles(...ROLESETS.all), schema: { querystring: PendenzQuerySchema } },
    async (request): Promise<PendenzenResponse> =>
      listPendenzen(app.db, adaptersFor(request), request.auth!, request.query as Parameters<typeof listPendenzen>[3], app.ctx.now()),
  );

  /** Persons for the admin person filter (real admins, also during «Ansicht als»). */
  app.get('/persons', { config: requireRealAdmin() }, async (): Promise<{ items: PendenzPerson[] }> => ({ items: await listPersons(app.db) }));

  // ---- CRM tasks: erledigen / verschieben ---------------------------------------------------------------------------
  app.post(
    '/tasks/:taskId/complete',
    {
      config: requireRoles(...ROLESETS.all),
      schema: { params: z.object({ taskId: crmId }), body: z.object({ userId: z.string().uuid().optional() }).strict() },
    },
    async (request) => completeTask(app.db, adaptersFor(request), request.auth!, request.params.taskId, request.body.userId),
  );

  app.post(
    '/tasks/:taskId/reschedule',
    {
      config: requireRoles(...ROLESETS.all),
      schema: {
        params: z.object({ taskId: crmId }),
        body: z.object({ dueAt: isoDateTime, userId: z.string().uuid().optional() }).strict(),
      },
    },
    async (request) =>
      rescheduleTask(app.db, adaptersFor(request), request.auth!, request.params.taskId, new Date(request.body.dueAt).toISOString(), request.body.userId),
  );

  // ---- Portal-side Pendenzen: erledigt / verschoben bis --------------------------------------------------------------
  app.put(
    '/state',
    {
      config: requireRoles(...ROLESETS.all),
      schema: {
        body: z
          .object({
            itemKey: ITEM_KEY,
            done: z.boolean().optional(),
            snoozedUntil: isoDateTime.nullable().optional(),
            userId: z.string().uuid().optional(),
          })
          .strict(),
      },
    },
    async (request) => setPendenzState(app.db, request.auth!, request.body, app.ctx.now()),
  );

  // ---- Saved filters (own only) -------------------------------------------------------------------------------------
  app.get('/filters', { config: requireRoles(...ROLESETS.all) }, async (request) => ({
    items: await listSavedFilters(app.db, request.auth!.user.id),
  }));

  app.post(
    '/filters',
    {
      config: requireRoles(...ROLESETS.all),
      schema: { body: z.object({ name: z.string().trim().min(1).max(60), filter: PendenzFilterSchema, isDefault: z.boolean().optional() }).strict() },
    },
    async (request, reply) => {
      const saved = await createSavedFilter(app.db, request.auth!.user.id, request.body as Parameters<typeof createSavedFilter>[2]);
      return reply.status(201).send(saved);
    },
  );

  app.put(
    '/filters/:id',
    {
      config: requireRoles(...ROLESETS.all),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({ name: z.string().trim().min(1).max(60).optional(), filter: PendenzFilterSchema.optional(), isDefault: z.boolean().optional() })
          .strict(),
      },
    },
    async (request) => updateSavedFilter(app.db, request.auth!.user.id, request.params.id, request.body as Parameters<typeof updateSavedFilter>[3]),
  );

  app.delete(
    '/filters/:id',
    { config: requireRoles(...ROLESETS.all), schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      await deleteSavedFilter(app.db, request.auth!.user.id, request.params.id);
      return reply.status(204).send();
    },
  );
};
