/**
 * /api/calls – Anruf-Session: Wählen → Verbunden → Aufgelegt → Nachbearbeitung, Notiz-Entwurf (INTENT 6.2, 6.3).
 * OWNER: coldcall implementer. Table: `call_sessions`. Dial links via `adaptersFor(request).telephony`.
 *
 *   POST /api/calls                   { leadId, direction?: 'outbound'|'inbound', phoneE164?, reason? } → { call, dial, resumed }
 *                                     inbound = «Rückruf angenommen» (history module), starts connected
 *   GET  /api/calls/active            newest running / unfinished call of the user
 *   GET  /api/calls/today             own progress today { calls, conversations, notReached } (Tagesziel)
 *   GET  /api/calls?scope=unfinished|recent[&userId=…|&all=true (admin)][&leadId=…]   (Pendenzen)
 *   GET  /api/calls/:id
 *   POST /api/calls/:id/connected     «Verbunden»
 *   POST /api/calls/:id/hangup        «Aufgelegt» → Nachbearbeitung
 *   POST /api/calls/:id/not-reached   «Nicht erreicht» (one click = approval) → { call, changeSet, nextAttemptAt, suggestMail … }
 *   POST /api/calls/:id/undo-not-reached
 *   PUT  /api/calls/:id/note          { note } (debounced autosave)
 *   PUT  /api/calls/:id/vera          { enabled }
 *   POST /api/calls/:id/abandon       only while dialing
 */
import type { CallSession } from '@sales-portal/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLESETS, requireRoles } from '../../auth/rbac';
import { adaptersFor } from '../../integrations';
import { crmId, queryBool } from '../../lib/zod';
import {
  abandonCall,
  getActiveCall,
  getCall,
  hangUp,
  listCalls,
  markConnected,
  NOTE_MAX_LENGTH,
  notReached,
  saveNote,
  setVera,
  startCall,
  todayProgress,
  undoNotReached,
  type CallCtx,
} from './service';

const idParams = z.object({ id: z.string().uuid() });
const roles = requireRoles(...ROLESETS.coldcall);

export const callsRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctxOf = (request: Parameters<typeof adaptersFor>[0]): CallCtx => {
    const adapters = adaptersFor(request);
    return {
      db: app.db,
      crm: adapters.crm,
      adapters,
      auth: request.auth!,
      now: app.ctx.now,
      ai: { config: app.config, db: app.db, adapters: app.ctx.adapters.system(), log: app.ctx.log, now: app.ctx.now },
    };
  };

  // Tagesziel (INTENT 4): own calls / conversations today. The goal itself is a personal value in the browser.
  app.get('/today', { config: roles }, async (request) => todayProgress(ctxOf(request)));

  app.get('/active', { config: roles }, async (request): Promise<{ call: CallSession | null }> => ({
    call: await getActiveCall(app.db, request.auth!.user.id),
  }));

  app.get(
    '/',
    {
      config: roles,
      schema: {
        querystring: z.object({
          scope: z.enum(['unfinished', 'recent']).optional(),
          userId: z.string().uuid().optional(),
          all: queryBool,
          leadId: crmId.optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
    },
    async (request) => ({ items: await listCalls(ctxOf(request), request.query) }),
  );

  app.post(
    '/',
    {
      config: roles,
      schema: {
        body: z
          .object({
            leadId: crmId,
            direction: z.enum(['outbound', 'inbound']).optional(),
            phoneE164: z.string().trim().max(40).nullable().optional(),
            reason: z.string().trim().max(200).nullable().optional(),
            override: z.object({ reason: z.string().trim().min(3).max(300) }).strict().nullable().optional(),
          })
          .strict(),
      },
    },
    async (request) => startCall(ctxOf(request), request.body),
  );

  app.get('/:id', { config: roles, schema: { params: idParams } }, async (request) => getCall(ctxOf(request), request.params.id));

  app.post('/:id/connected', { config: roles, schema: { params: idParams } }, async (request) => markConnected(ctxOf(request), request.params.id));
  app.post('/:id/hangup', { config: roles, schema: { params: idParams } }, async (request) => hangUp(ctxOf(request), request.params.id));
  app.post('/:id/not-reached', { config: roles, schema: { params: idParams } }, async (request) => notReached(ctxOf(request), request.params.id));
  app.post('/:id/undo-not-reached', { config: roles, schema: { params: idParams } }, async (request) => undoNotReached(ctxOf(request), request.params.id));
  app.post('/:id/abandon', { config: roles, schema: { params: idParams } }, async (request) => abandonCall(ctxOf(request), request.params.id));

  app.put(
    '/:id/note',
    // Autosave fires often while typing – a generous per-route limit on top of the global one.
    { config: { ...roles, rateLimit: { max: 240, timeWindow: '1 minute' } }, schema: { params: idParams, body: z.object({ note: z.string().max(NOTE_MAX_LENGTH) }).strict() } },
    async (request) => saveNote(ctxOf(request), request.params.id, request.body.note),
  );

  app.put(
    '/:id/vera',
    { config: roles, schema: { params: idParams, body: z.object({ enabled: z.boolean() }).strict() } },
    async (request) => setVera(ctxOf(request), request.params.id, request.body.enabled),
  );
};
