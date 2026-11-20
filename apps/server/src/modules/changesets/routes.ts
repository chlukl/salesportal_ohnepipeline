/**
 * /api/changesets – Ergebnisgruppe → Vorschau alt→neu → Konfliktprüfung → Push → Protokoll (INTENT 6.5, 6.9).
 * OWNER: coldcall implementer. Tables: `change_sets`, `audit_log`, `result_group_rules` (versioned).
 *
 *   GET  /api/changesets/rules                      active result groups (wrap-up panel)
 *   GET  /api/changesets?status=draft,conflict,failed[&userId=…|&all=true (admin)][&leadId=…]
 *   GET  /api/changesets/:id
 *   POST /api/changesets            { leadId, callSessionId?, ruleKey, input, changeSetId? } → { changeSet, issues }
 *   POST /api/changesets/:id/push   { resolutions?: { [opId]: 'overwrite' | 'keep_crm' } } → { status, changeSet }
 *   POST /api/changesets/:id/discard
 *   POST /api/changesets/:id/revert { reason? } → { revert, skipped }
 */
import { RESULT_GROUP_KEYS } from '@sales-portal/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLESETS, requireRoles } from '../../auth/rbac';
import { adaptersFor } from '../../integrations';
import { csv, crmId, isoDateTime, queryBool } from '../../lib/zod';
import { loadActiveRules } from './rules';
import {
  discardChangeSet,
  listChangeSets,
  loadOwnedRow,
  pushChangeSet,
  revertChangeSet,
  toChangeSet,
  upsertDraft,
  type AccessOptions,
  type ChangeSetCtx,
} from './service';

const STATUSES = ['draft', 'pending', 'conflict', 'pushed', 'failed', 'discarded'] as const;

export const NewPersonSchema = z
  .object({
    salutation: z.number().int().nullable().optional(),
    firstname: z.string().trim().max(80).default(''),
    lastname: z.string().trim().max(80),
    jobtitle: z.string().trim().max(120).nullable().optional(),
    email: z.string().trim().max(200).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    samePerson: z.boolean(),
  })
  .strict();

export const ResultInputSchema = z
  .object({
    followUpAt: isoDateTime.nullable().optional(),
    interest: z.number().int().min(0).max(3).nullable().optional(),
    employees: z.number().int().min(0).max(10_000_000).nullable().optional(),
    correctedPhone: z.string().trim().max(40).nullable().optional(),
    correctedPhoneField: z.enum(['telephone1', 'mobilephone']).nullable().optional(),
    decisionMakerInMeeting: z.boolean().nullable().optional(),
    reason: z.string().max(2000).nullable().optional(),
    newPerson: NewPersonSchema.nullable().optional(),
    budgetMentioned: z.boolean().nullable().optional(),
  })
  .strict();

const idParams = z.object({ id: z.string().uuid() });
/** The generic routes never push / rebuild / discard change sets with their own approval flow (AI analyses). */
const GENERIC: AccessOptions = { external: true };

export const changesetsRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctxOf = (request: Parameters<typeof adaptersFor>[0]): ChangeSetCtx => ({
    db: app.db,
    crm: adaptersFor(request).crm,
    auth: request.auth!,
    now: app.ctx.now,
  });

  app.get('/rules', { config: requireRoles(...ROLESETS.coldcall) }, async () => ({ items: await loadActiveRules(app.db) }));

  app.get(
    '/',
    {
      config: requireRoles(...ROLESETS.coldcall),
      schema: {
        querystring: z.object({
          status: csv(z.enum(STATUSES)),
          userId: z.string().uuid().optional(),
          all: queryBool,
          leadId: crmId.optional(),
        }),
      },
    },
    async (request) => ({
      items: await listChangeSets(ctxOf(request), {
        status: request.query.status,
        userId: request.query.userId,
        all: request.query.all,
        leadId: request.query.leadId,
      }),
    }),
  );

  app.get('/:id', { config: requireRoles(...ROLESETS.coldcall), schema: { params: idParams } }, async (request) =>
    toChangeSet(await loadOwnedRow(ctxOf(request), request.params.id)),
  );

  app.post(
    '/',
    {
      config: requireRoles(...ROLESETS.coldcall),
      schema: {
        body: z
          .object({
            leadId: crmId,
            callSessionId: z.string().uuid().nullable().optional(),
            ruleKey: z.enum(RESULT_GROUP_KEYS),
            input: ResultInputSchema.default({}),
            changeSetId: z.string().uuid().nullable().optional(),
          })
          .strict(),
      },
    },
    async (request) => upsertDraft(ctxOf(request), request.body, GENERIC),
  );

  app.post(
    '/:id/push',
    {
      config: requireRoles(...ROLESETS.coldcall),
      schema: {
        params: idParams,
        body: z.object({ resolutions: z.record(z.string().max(80), z.enum(['overwrite', 'keep_crm'])).optional() }).strict(),
      },
    },
    async (request) => pushChangeSet(ctxOf(request), request.params.id, request.body.resolutions ?? {}, GENERIC),
  );

  app.post('/:id/discard', { config: requireRoles(...ROLESETS.coldcall), schema: { params: idParams } }, async (request) => ({
    changeSet: await discardChangeSet(ctxOf(request), request.params.id, GENERIC),
  }));

  app.post(
    '/:id/revert',
    {
      config: requireRoles(...ROLESETS.coldcall),
      schema: { params: idParams, body: z.object({ reason: z.string().max(500).optional() }).strict() },
    },
    async (request) => revertChangeSet(ctxOf(request), request.params.id, { reason: request.body.reason }),
  );
};
