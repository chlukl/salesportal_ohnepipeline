/**
 * /api/leads – Anrufliste, Filter, gespeicherte Filter, Spaltenwahl (INTENT 6.1, 6.13).
 * OWNER: coldcall implementer.
 *
 *   GET    /api/leads?grades=A,B&employeeBands=50-249&sort=due_then_score&page=1&pageSize=50 → Paged<Lead>
 *          defaults: requirePhone=true, hideRetryPending=true, campaign=exclude_locked (explicit false lifts them)
 *   GET    /api/leads/next?currentLeadId=…&skip=id1,id2&<same filters> → { lead | null }   («nächster Lead»)
 *   GET    /api/leads/options → filter values (Branchen, Kategorien, Kantone, Themen, Besitzer, Kampagnen)
 *   GET    /api/leads/filters · POST /api/leads/filters · PUT /api/leads/filters/:id · DELETE /api/leads/filters/:id
 */
import { GRADES, type Lead, type LeadQuery, type Paged } from '@sales-portal/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLESETS, requireRoles } from '../../auth/rbac';
import { adaptersFor } from '../../integrations';
import { crmId, csv, queryBool } from '../../lib/zod';
import { createSavedFilter, deleteSavedFilter, listLeads, listSavedFilters, nextLead, updateSavedFilter } from './service';

const EMPLOYEE_BANDS = ['1-4', '5-9', '10-19', '20-49', '50-249', '250-999', '1000+', 'unknown'] as const;
const ORG_TYPES = ['private', 'public', 'association', 'unknown'] as const;
const CONTACT_ROLES = ['management', 'it', 'finance_operations', 'sales_marketing', 'production', 'other', 'unknown'] as const;
const SORTS = ['score', 'companyname', 'numberofemployees', 'lastRealContact', 'nextDueAt', 'modifiedon', 'city', 'due_then_score'] as const;

export const LeadQuerySchema = z.object({
  search: z.string().max(100).optional(),
  grades: csv(z.enum(GRADES as [string, ...string[]])),
  scoreMin: z.coerce.number().min(0).max(100).optional(),
  scoreMax: z.coerce.number().min(0).max(100).optional(),
  employeeBands: csv(z.enum(EMPLOYEE_BANDS)),
  industries: csv(z.string().max(100)),
  excludeIndustries: csv(z.string().max(100)),
  customIndustries: csv(z.string().max(100)),
  orgTypes: csv(z.enum(ORG_TYPES)),
  cantons: csv(z.string().length(2)),
  plzPrefixes: csv(z.string().regex(/^\d{1,4}$/)),
  callStatuses: csv(z.coerce.number().int()),
  ratingCategories: csv(z.coerce.number().int()),
  statusCodes: csv(z.coerce.number().int()),
  noContactSinceDays: z.coerce.number().int().min(0).max(3650).optional(),
  subjects: csv(z.string().max(200)),
  leadSources: csv(z.coerce.number().int()),
  leadSupport: csv(z.coerce.number().int()),
  campaign: z.enum(['exclude_locked', 'only_from_campaign', 'only_locked', 'all']).optional(),
  campaignNames: csv(z.string().max(200)),
  contactRoles: csv(z.enum(CONTACT_ROLES)),
  requirePhone: queryBool,
  requireEmail: queryBool,
  hideRetryPending: queryBool,
  ownerIds: csv(z.string().max(100)),
  due: z.enum(['overdue', 'today', 'this_week', 'any_open', 'none']).optional(),
  decisionMaker: queryBool,
  includeHidden: queryBool,
  sort: z.enum(SORTS).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

const FilterBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    filter: LeadQuerySchema.omit({ page: true, pageSize: true }),
    columns: z.array(z.string().max(40)).max(30).nullable().optional(),
    sort: z.object({ key: z.enum(SORTS), direction: z.enum(['asc', 'desc']) }).nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

/** Hidden leads (closed, Divendo, …) only for admins. */
function sanitize(query: LeadQuery, isAdmin: boolean): LeadQuery {
  return isAdmin ? query : { ...query, includeHidden: false };
}

export const leadsRoutes: FastifyPluginAsyncZod = async (app) => {
  const roles = requireRoles(...ROLESETS.coldcall);
  const admin = (request: { auth: { effectiveRoles: string[] } | null }) => !!request.auth?.effectiveRoles.includes('admin');

  app.get('/', { config: roles, schema: { querystring: LeadQuerySchema } }, async (request): Promise<Paged<Lead>> =>
    listLeads(adaptersFor(request), sanitize({ ...request.query } as LeadQuery, admin(request))),
  );

  app.get(
    '/next',
    {
      config: roles,
      schema: { querystring: LeadQuerySchema.extend({ currentLeadId: crmId.optional(), skip: csv(crmId, 500) }) },
    },
    async (request): Promise<{ lead: Lead | null }> => {
      const { currentLeadId, skip, ...query } = request.query;
      return { lead: await nextLead(adaptersFor(request), sanitize(query as LeadQuery, admin(request)), currentLeadId, skip ?? []) };
    },
  );

  app.get('/options', { config: roles }, async (request) => adaptersFor(request).crm.getFilterOptions());

  app.get('/filters', { config: roles }, async (request) => ({ items: await listSavedFilters(app.db, request.auth!.user.id) }));

  app.post('/filters', { config: roles, schema: { body: FilterBody } }, async (request) =>
    createSavedFilter(app.db, request.auth!.user.id, { ...request.body, filter: request.body.filter as LeadQuery }, app.ctx.now()),
  );

  app.put('/filters/:id', { config: roles, schema: { params: z.object({ id: z.string().uuid() }), body: FilterBody.partial() } }, async (request) =>
    updateSavedFilter(
      app.db,
      request.auth!.user.id,
      request.params.id,
      { ...request.body, filter: request.body.filter as LeadQuery | undefined },
      app.ctx.now(),
    ),
  );

  app.delete('/filters/:id', { config: roles, schema: { params: z.object({ id: z.string().uuid() }) } }, async (request, reply) => {
    await deleteSavedFilter(app.db, request.auth!.user.id, request.params.id);
    reply.status(204);
    return null;
  });
};
