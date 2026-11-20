/**
 * Optional Vera webhook (INTENT 6.3, open question 2): Vera notifies the portal that a transcript is ready; the portal
 * then pulls it through the TranscriptAdapter (the webhook body is only a hint, never trusted as transcript content).
 *
 * Authentication (no session, machine-to-machine):
 *   X-Vera-Timestamp: <unix seconds>       must be within ±5 minutes
 *   X-Vera-Delivery:  <unique delivery id> replay protection (stored in `sync_state`, rejected when seen before)
 *   X-Vera-Signature: sha256=<hex>         HMAC-SHA256(secret, `${timestamp}.${deliveryId}.${rawBody}`), constant-time compared
 *
 * NOT MOUNTED YET: the foundation only allows public routes under /api/health and /api/auth (rbac.ts), and the CSRF hook
 * requires a same-origin signal for unsafe methods. Mounting needs a foundation change (see ARCHITECTURE «Änderungen» /
 * open issues): a machine-route declaration that skips session + origin checks, plus `VERA_WEBHOOK_SECRET(_FILE)` in config.
 * Then: `app.register(veraWebhookPlugin({ secret, deps }), { prefix: '/api/ai' })`.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, like, lt } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { analyses, callSessions, syncState } from '../../db/schema';
import { enqueueJob } from '../../jobs/queue';
import { audit } from '../../lib/audit';
import type { AiDeps } from './common';
import { JOB_FETCH_TRANSCRIPT, matchCallSession, onCallSessionEnded } from './transcripts';

export const WEBHOOK_TOLERANCE_SEC = 300;
const NONCE_PREFIX = 'vera_webhook:';
const MAX_BODY_BYTES = 64 * 1024;

export type WebhookVerdict = { ok: true } | { ok: false; status: 400 | 401 | 409; code: string };

export function signVeraPayload(secret: string, timestamp: string, deliveryId: string, rawBody: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.`).update(rawBody).digest('hex')}`;
}

/** Signature + timestamp check (pure). Replay protection is done separately with the store. */
export function verifyVeraSignature(
  secret: string,
  headers: { timestamp?: string; deliveryId?: string; signature?: string },
  rawBody: Buffer,
  now: Date,
): WebhookVerdict {
  const { timestamp, deliveryId, signature } = headers;
  if (!secret || !timestamp || !deliveryId || !signature) return { ok: false, status: 401, code: 'signature_missing' };
  if (!/^\d{9,11}$/.test(timestamp) || !/^[\w.-]{8,128}$/.test(deliveryId)) return { ok: false, status: 400, code: 'header_invalid' };
  const age = Math.abs(now.getTime() / 1000 - Number(timestamp));
  if (age > WEBHOOK_TOLERANCE_SEC) return { ok: false, status: 401, code: 'timestamp_out_of_range' };
  const expected = Buffer.from(signVeraPayload(secret, timestamp, deliveryId, rawBody));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, status: 401, code: 'signature_invalid' };
  return { ok: true };
}

/** Remember a delivery id; false when it was seen before (replay). */
export async function claimDelivery(deps: Pick<AiDeps, 'db' | 'now'>, deliveryId: string): Promise<boolean> {
  const key = `${NONCE_PREFIX}${createHash('sha256').update(deliveryId).digest('hex')}`;
  const inserted = await deps.db
    .insert(syncState)
    .values({ key, value: { at: deps.now().toISOString() }, updatedAt: deps.now() })
    .onConflictDoNothing()
    .returning({ key: syncState.key });
  return inserted.length === 1;
}

/** Delete remembered delivery ids older than twice the tolerance (recurring job). */
export async function cleanupDeliveries(deps: Pick<AiDeps, 'db' | 'now'>): Promise<void> {
  const before = new Date(deps.now().getTime() - 2 * WEBHOOK_TOLERANCE_SEC * 1000);
  await deps.db.delete(syncState).where(and(like(syncState.key, `${NONCE_PREFIX}%`), lt(syncState.updatedAt, before)));
}

export const VeraWebhookBody = z.object({
  event: z.enum(['transcript.ready', 'transcript.failed']),
  callRef: z.string().min(1).max(200),
  userEmail: z.string().email().max(200),
  startedAt: z.string().datetime({ offset: true }),
});

/** Handle a verified notification: link the Vera call to the portal call and pull the transcript right away. */
export async function handleVeraNotification(deps: AiDeps, body: z.infer<typeof VeraWebhookBody>): Promise<{ matched: boolean }> {
  const callSessionId = await matchCallSession(deps, body.userEmail, new Date(body.startedAt));
  if (!callSessionId) return { matched: false };
  await deps.db.update(callSessions).set({ transcriptRef: body.callRef, updatedAt: deps.now() }).where(eq(callSessions.id, callSessionId));
  const analysisId = await onCallSessionEnded(deps, callSessionId);
  if (analysisId && body.event === 'transcript.ready') {
    const [a] = await deps.db.select({ status: analyses.status }).from(analyses).where(eq(analyses.id, analysisId));
    if (a?.status === 'pending') await enqueueJob(deps.db, JOB_FETCH_TRANSCRIPT, { analysisId }, { maxAttempts: 3 });
  }
  await audit(deps.db, { actor: 'system', action: 'vera.webhook', entity: 'call_session', entityId: callSessionId, meta: { event: body.event } });
  return { matched: true };
}

/** Fastify plugin for the webhook (raw body for the HMAC). Mount only once the foundation allows machine routes. */
export function veraWebhookPlugin(options: { secret: string; deps: () => AiDeps; routeConfig: Record<string, unknown> }): FastifyPluginAsync {
  return async (app) => {
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES }, (_req, body, done) => done(null, body));
    app.post('/vera/webhook', { config: options.routeConfig, bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
      const deps = options.deps();
      const raw = request.body as Buffer;
      const h = (name: string) => {
        const v = request.headers[name];
        return Array.isArray(v) ? v[0] : v;
      };
      const verdict = verifyVeraSignature(
        options.secret,
        { timestamp: h('x-vera-timestamp'), deliveryId: h('x-vera-delivery'), signature: h('x-vera-signature') },
        raw,
        deps.now(),
      );
      if (!verdict.ok) return reply.status(verdict.status).send({ error: { code: verdict.code, message: 'Abgelehnt' } });
      if (!(await claimDelivery(deps, h('x-vera-delivery')!))) return reply.status(409).send({ error: { code: 'replay', message: 'Bereits verarbeitet' } });
      let parsed: z.infer<typeof VeraWebhookBody>;
      try {
        parsed = VeraWebhookBody.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        return reply.status(400).send({ error: { code: 'validation_error', message: 'Ungültige Daten' } });
      }
      const result = await handleVeraNotification(deps, parsed);
      return reply.status(202).send({ accepted: true, matched: result.matched });
    });
  };
}
