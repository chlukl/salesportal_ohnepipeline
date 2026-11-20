/**
 * /api/admin – Rollen, Ergebnisgruppen-Editor, Vorlagen, Terminregeln, Einwände, Einstellungen, Verbindungen,
 * Protokoll, Fehler (INTENT 6.14).
 *
 * Security: every route declares `requireRoles('admin')` (exception: the use-case catalog, see below) (effective roles → an admin viewing as another role is
 * denied, so «Ansicht als» never escalates). Writes additionally require the REAL admin flag (defense in depth) and
 * are audited in the service.
 */
import { RESULT_GROUP_KEYS, ROLES } from '@sales-portal/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRoles, type RequestAuth } from '../../auth/rbac';
import { adaptersFor } from '../../integrations';
import { forbidden } from '../../lib/errors';
import { SECRET_NAMES } from './extraSettings';
import { placeholdersFor } from './templates';
import { createUseCase, getUseCaseCatalog, sortUseCases, updateUseCase, useCaseCreateSchema, useCaseIdSchema, useCaseUpdateSchema } from './useCases';
import {
  adminSettingsSchema,
  auditFacets,
  auditQuerySchema,
  bookingRulesSchema,
  createObjection,
  createUser,
  createUserSchema,
  getAdminSettings,
  getBookingRules,
  getConnections,
  listActiveRules,
  listAudit,
  listErrors,
  listObjections,
  listRuleVersions,
  listTemplates,
  listUsers,
  objectionSchema,
  proposeRevert,
  restoreRuleVersion,
  retryJob,
  ruleMeta,
  saveRuleVersion,
  secretExpirySchema,
  setSecretExpiry,
  setUserActive,
  setUserRoles,
  templateUpdateSchema,
  updateAdminSettings,
  updateBookingRules,
  updateObjection,
  updateTemplate,
} from './service';

const ADMIN = requireRoles('admin');
const uuidParams = z.object({ id: z.string().uuid() });
const keyParams = z.object({ key: z.enum(RESULT_GROUP_KEYS) });
/** Use-Case-Katalog (INTENT 3): read for Sales + AI-Spezialist, maintained by the AI-Spezialist (and Admin). */
const USE_CASE_READERS = ['sales', 'ai_specialist', 'admin'] as const;
const USE_CASE_EDITORS = ['ai_specialist', 'admin'] as const;

/** Writes only for the real admin (never through «Ansicht als» of another role – already denied by requireRoles). */
function writer(auth: RequestAuth | null) {
  if (!auth || !auth.isRealAdmin || !auth.effectiveRoles.includes('admin')) throw forbidden();
  return auth.actor;
}

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  // ---- users & roles -----------------------------------------------------------------------------------------------
  app.get('/users', { config: ADMIN }, async () => ({ items: await listUsers(app.db) }));

  app.post('/users', { config: ADMIN, schema: { body: createUserSchema } }, async (request) => createUser(app.db, writer(request.auth), request.body));

  app.put(
    '/users/:id/roles',
    { config: ADMIN, schema: { params: uuidParams, body: z.strictObject({ roles: z.array(z.enum(ROLES)).max(ROLES.length) }) } },
    async (request) => setUserRoles(app.db, writer(request.auth), request.params.id, request.body.roles),
  );

  app.put(
    '/users/:id/active',
    { config: ADMIN, schema: { params: uuidParams, body: z.strictObject({ isActive: z.boolean() }) } },
    async (request) => setUserActive(app.db, writer(request.auth), request.params.id, request.body.isActive),
  );

  // ---- result-group rules ------------------------------------------------------------------------------------------
  app.get('/rules', { config: ADMIN }, async () => ({ items: await listActiveRules(app.db), meta: ruleMeta() }));

  app.get('/rules/:key/versions', { config: ADMIN, schema: { params: keyParams } }, async (request) => ({
    items: await listRuleVersions(app.db, request.params.key),
  }));

  // Body is validated in depth by the shared-type zod schema in the service (key/version are set by the server).
  app.put(
    '/rules/:key',
    { config: ADMIN, schema: { params: keyParams, body: z.object({ definition: z.record(z.string(), z.unknown()) }) } },
    async (request) => saveRuleVersion(app.db, writer(request.auth), request.params.key, request.body.definition),
  );

  app.post(
    '/rules/:key/restore',
    { config: ADMIN, schema: { params: keyParams, body: z.strictObject({ version: z.number().int().min(1) }) } },
    async (request) => restoreRuleVersion(app.db, writer(request.auth), request.params.key, request.body.version),
  );

  // ---- templates ---------------------------------------------------------------------------------------------------
  app.get('/templates', { config: ADMIN }, async () => {
    const items = await listTemplates(app.db);
    return { items: items.map((t) => ({ ...t, placeholders: placeholdersFor(t.kind) })) };
  });

  app.put(
    '/templates/:id',
    { config: ADMIN, schema: { params: uuidParams, body: templateUpdateSchema } },
    async (request) => {
      const t = await updateTemplate(app.db, writer(request.auth), request.params.id, request.body);
      return { ...t, placeholders: placeholdersFor(t.kind) };
    },
  );

  // ---- objections --------------------------------------------------------------------------------------------------
  app.get('/objections', { config: ADMIN }, async () => ({ items: await listObjections(app.db) }));

  app.post('/objections', { config: ADMIN, schema: { body: objectionSchema } }, async (request) =>
    createObjection(app.db, writer(request.auth), request.body),
  );

  app.put(
    '/objections/:id',
    { config: ADMIN, schema: { params: uuidParams, body: objectionSchema.partial() } },
    async (request) => updateObjection(app.db, writer(request.auth), request.params.id, request.body),
  );

  // ---- booking rules & settings ------------------------------------------------------------------------------------
  app.get('/booking-rules', { config: ADMIN }, async () => getBookingRules(app.db));

  app.put('/booking-rules', { config: ADMIN, schema: { body: bookingRulesSchema } }, async (request) =>
    updateBookingRules(app.db, writer(request.auth), request.body),
  );

  app.get('/settings', { config: ADMIN }, async () => getAdminSettings(app.db));

  app.put('/settings', { config: ADMIN, schema: { body: adminSettingsSchema.partial() } }, async (request) =>
    updateAdminSettings(app.db, writer(request.auth), request.body),
  );

  // ---- connections / secrets / environment -------------------------------------------------------------------------
  app.get('/connections', { config: ADMIN }, async () => getConnections(app.db, app.config, app.ctx.now()));

  app.put(
    '/connections/secrets/:name',
    { config: ADMIN, schema: { params: z.object({ name: z.enum(SECRET_NAMES) }), body: secretExpirySchema } },
    async (request) => {
      await setSecretExpiry(app.db, writer(request.auth), request.params.name, request.body.expiresOn);
      return getConnections(app.db, app.config, app.ctx.now());
    },
  );

  // ---- audit log ---------------------------------------------------------------------------------------------------
  app.get('/audit', { config: ADMIN, schema: { querystring: auditQuerySchema } }, async (request) => listAudit(app.db, request.query));

  app.get('/audit/facets', { config: ADMIN }, async () => auditFacets(app.db));

  app.post(
    '/audit/:id/revert',
    { config: ADMIN, schema: { params: z.object({ id: z.coerce.number().int().positive() }) } },
    async (request) => proposeRevert(app.db, adaptersFor(request), writer(request.auth), request.params.id),
  );

  // ---- use-case catalog (not admin-only: AI-Spezialist maintains it, Sales reads it) -------------------------------
  app.get('/use-cases', { config: requireRoles(...USE_CASE_READERS) }, async (request) => ({
    items: sortUseCases(await getUseCaseCatalog(app.db)),
    canEdit: USE_CASE_EDITORS.some((r) => request.auth?.effectiveRoles.includes(r) ?? false),
  }));

  app.post('/use-cases', { config: requireRoles(...USE_CASE_EDITORS), schema: { body: useCaseCreateSchema } }, async (request) =>
    createUseCase(app.db, request.auth!.actor, request.body, app.ctx.now()),
  );

  app.put(
    '/use-cases/:id',
    { config: requireRoles(...USE_CASE_EDITORS), schema: { params: z.object({ id: useCaseIdSchema }), body: useCaseUpdateSchema } },
    async (request) => updateUseCase(app.db, request.auth!.actor, request.params.id, request.body, app.ctx.now()),
  );

  // ---- errors ------------------------------------------------------------------------------------------------------
  app.get('/errors', { config: ADMIN }, async () => ({ items: await listErrors(app.db) }));

  app.post(
    '/errors/jobs/:id/retry',
    { config: ADMIN, schema: { params: z.object({ id: z.coerce.number().int().positive() }) } },
    async (request) => {
      await retryJob(app.db, writer(request.auth), request.params.id);
      return { ok: true };
    },
  );
};
