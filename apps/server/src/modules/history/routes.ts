/**
 * /api/history – Anrufhistorie mit Kategorien (ausgehend, Rückruf angenommen/verpasst, unbekannte Nummer) und
 * Rückruf-Suche (INTENT 6.15, 6.18). Fremde Historie nur für Admins.
 */
import type { CallbackSearchResponse, HistoryResponse } from '@sales-portal/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLESETS, requireRoles } from '../../auth/rbac';
import { adaptersFor } from '../../integrations';
import { crmId, csv, queryBool } from '../../lib/zod';
import { CALL_CATEGORIES } from './rules';
import { assignPhone, callbackSearch, listHistory, removeAssignment, setHandled } from './service';

const HistoryQuerySchema = z.object({
  categories: csv(z.enum(CALL_CATEGORIES as [string, ...string[]]), 4),
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT')
    .optional(),
  resultCodes: csv(z.coerce.number().int().min(0).max(999_999_999), 20),
  search: z.string().max(100).optional(),
  onlyOpen: queryBool,
  userId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export const historyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/',
    { config: requireRoles(...ROLESETS.coldcall), schema: { querystring: HistoryQuerySchema } },
    async (request): Promise<HistoryResponse & { warnings: string[] }> =>
      listHistory(app.db, adaptersFor(request), request.auth!, request.query as Parameters<typeof listHistory>[3], app.ctx.now()),
  );

  /** Missed callback / unknown number done (or undo with handled=false). */
  app.post(
    '/sessions/:id/handled',
    {
      config: requireRoles(...ROLESETS.coldcall),
      schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ handled: z.boolean() }).strict() },
    },
    async (request) => setHandled(app.db, request.auth!, request.params.id, request.body.handled, app.ctx.now()),
  );

  /** Rückruf-Suche: number in any format (or name / company). */
  app.get(
    '/callback-search',
    { config: requireRoles(...ROLESETS.coldcall), schema: { querystring: z.object({ q: z.string().trim().min(1).max(60) }) } },
    async (request): Promise<CallbackSearchResponse> => callbackSearch(app.db, adaptersFor(request), request.query.q),
  );

  /** Unknown number → assign to a lead (portal mapping; the CRM is not changed). */
  app.post(
    '/assignments',
    {
      config: requireRoles(...ROLESETS.coldcall),
      schema: { body: z.object({ phone: z.string().trim().min(3).max(40), leadId: crmId }).strict() },
    },
    async (request, reply) => reply.status(201).send(await assignPhone(app.db, adaptersFor(request), request.auth!, request.body)),
  );

  app.delete(
    '/assignments/:id',
    { config: requireRoles(...ROLESETS.coldcall), schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      await removeAssignment(app.db, request.auth!, request.params.id);
      return reply.status(204).send();
    },
  );
};
