/**
 * /api/ai – Analysen zur Freigabe, Use-Case-Mail, Briefing (INTENT 6.4, 6.7, 6.10).
 *
 * Roles: analyses + use-case mail = coldcaller/admin (own objects; admin may look at others via `userId`),
 * briefings = all workspace roles with object-level checks (common.ts canViewBriefing), budget = admin.
 * Generating endpoints use the stricter AI rate limit. Every response is plain data – AI text is rendered as text.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLESETS, requireRoles, type RequestAuth } from '../../auth/rbac';
import { forbidden } from '../../lib/errors';
import { uuidParam } from '../../lib/zod';
import { approveAnalysis, dismissAnalysis, getReviewItem, listReviewItems } from './analysis';
import { budgetStatus } from './budget';
import { getBriefingView, requestBriefingRebuild, setBriefingStatus } from './briefing';
import { isAdmin } from './common';
import { aiDepsFor, listAnalyses } from './service';
import { discardUseCaseMail, draftUseCaseMail, sendUseCaseMail } from './useCaseMail';

/** Stricter rate limit for AI endpoints (ARCHITECTURE §5.7): `config: { ...requireRoles(...), rateLimit: AI_RATE_LIMIT }`. */
export const AI_RATE_LIMIT = { max: 20, timeWindow: '1 minute' };
const SEND_RATE_LIMIT = { max: 20, timeWindow: '1 minute' };

const statusEnum = z.enum(['pending', 'running', 'ready', 'approved', 'rejected', 'skipped', 'failed']);
const bookingParam = z.object({ bookingId: z.string().uuid() });
const email = z.string().trim().email('ungültige E-Mail-Adresse').max(200);
const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), 'keine Zeilenumbrüche');

/** `userId` filter: only admins may look at other people's analyses. */
function ownerFor(auth: RequestAuth, userId: string | undefined): string {
  if (!userId || userId === auth.user.id) return auth.user.id;
  if (!isAdmin(auth)) throw forbidden();
  return userId;
}

export const aiRoutes: FastifyPluginAsyncZod = async (app) => {
  // ---------------------------------------------------------------------------------------------------- analyses
  app.get(
    '/analyses',
    {
      config: requireRoles(...ROLESETS.workspace),
      schema: {
        querystring: z.object({
          status: statusEnum.optional(),
          kind: z.enum(['call', 'use_case_mail', 'briefing']).optional(),
          userId: z.string().uuid().optional(),
        }),
      },
    },
    async (request) => ({
      items: await listAnalyses(app.db, ownerFor(request.auth!, request.query.userId), request.query.status, request.query.kind),
    }),
  );

  app.get(
    '/analyses/review',
    { config: requireRoles(...ROLESETS.coldcall), schema: { querystring: z.object({ userId: z.string().uuid().optional() }) } },
    async (request) => ({ items: await listReviewItems(aiDepsFor(request), ownerFor(request.auth!, request.query.userId)) }),
  );

  app.get('/analyses/:id', { config: requireRoles(...ROLESETS.coldcall), schema: { params: uuidParam } }, async (request) =>
    getReviewItem(aiDepsFor(request), request.auth!, request.params.id),
  );

  app.post(
    '/analyses/:id/approve',
    {
      config: requireRoles(...ROLESETS.coldcall),
      schema: {
        params: uuidParam,
        body: z.object({
          acceptOpIds: z.array(z.string().min(1).max(80)).max(30).default([]),
          acceptLeadCreate: z.boolean().default(false),
          resolutions: z.record(z.string().max(80), z.enum(['overwrite', 'keep_crm'])).optional(),
          applyPreparation: z.boolean().default(false),
        }),
      },
    },
    // A conflict is a normal outcome (200 with status `conflict` + conflicts): Markus decides per field, then retries.
    async (request) => approveAnalysis(aiDepsFor(request), request.auth!, request.params.id, request.body),
  );

  app.post('/analyses/:id/dismiss', { config: requireRoles(...ROLESETS.coldcall), schema: { params: uuidParam } }, async (request) => ({
    analysis: await dismissAnalysis(aiDepsFor(request), request.auth!, request.params.id),
  }));

  // ---------------------------------------------------------------------------------------------- use-case mail
  app.post(
    '/use-case-mail/draft',
    {
      config: { ...requireRoles(...ROLESETS.coldcall), rateLimit: AI_RATE_LIMIT },
      schema: {
        body: z.object({
          leadId: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/),
          callSessionId: z.string().uuid().nullish(),
          research: z.boolean().default(false),
          includeProposals: z.boolean().default(false),
        }),
      },
    },
    async (request) => draftUseCaseMail(aiDepsFor(request), request.auth!, request.body),
  );

  app.post(
    '/use-case-mail/:id/send',
    {
      config: { ...requireRoles(...ROLESETS.coldcall), rateLimit: SEND_RATE_LIMIT },
      schema: {
        params: uuidParam,
        body: z.object({
          to: z.array(email).min(1).max(5),
          cc: z.array(email).max(5).optional(),
          subject: singleLine(200),
          body: z.string().trim().min(1).max(10_000),
        }),
      },
    },
    async (request) => sendUseCaseMail(aiDepsFor(request), request.auth!, request.params.id, request.body),
  );

  app.post('/use-case-mail/:id/discard', { config: requireRoles(...ROLESETS.coldcall), schema: { params: uuidParam } }, async (request) => {
    await discardUseCaseMail(aiDepsFor(request), request.auth!, request.params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------------------- briefings
  app.get('/briefings/:bookingId', { config: requireRoles(...ROLESETS.workspace), schema: { params: bookingParam } }, async (request) =>
    getBriefingView(aiDepsFor(request), request.auth!, request.params.bookingId),
  );

  app.post(
    '/briefings/:bookingId/status',
    {
      config: requireRoles(...ROLESETS.workspace),
      schema: { params: bookingParam, body: z.object({ status: z.enum(['open', 'read', 'prepared']) }) },
    },
    async (request) => ({
      status: await setBriefingStatus(aiDepsFor(request), request.auth!, request.params.bookingId, request.body.status),
    }),
  );

  app.post(
    '/briefings/:bookingId/regenerate',
    { config: { ...requireRoles(...ROLESETS.workspace), rateLimit: AI_RATE_LIMIT }, schema: { params: bookingParam } },
    async (request) => {
      await requestBriefingRebuild(aiDepsFor(request), request.auth!, request.params.bookingId);
      return { queued: true };
    },
  );

  // ---------------------------------------------------------------------------------------------- budget (admin)
  app.get('/budget', { config: requireRoles(...ROLESETS.admin) }, async () => budgetStatus(app.db, app.ctx.now()));
};
