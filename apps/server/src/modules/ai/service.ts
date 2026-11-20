/**
 * AI service – public entry points of the ai module for other modules.
 *
 *   calls module       → onCallSessionEnded(deps, callSessionId)    after «Aufgelegt» (Vera on → transcript + analysis)
 *   scheduling module  → onBookingCreated(deps, bookingId)          after booking (briefing is built and delivered)
 *                      → updateBriefingForBooking(deps, bookingId)  booking moved / preparation changed
 *                      → deleteBriefingForBooking(deps, bookingId)  booking cancelled
 *   pendenzen module   → countReadyAnalyses / listReviewItems, `bookings.briefing_status`
 *
 * `deps` = { config, db, adapters, log, now } – from a route: `aiDepsFor(request)`, from a job: `aiDepsFromJob(ctx)`.
 * Recurring sweeps make the flows work even without these calls (ended calls, bookings without briefing).
 */
import type { Analysis, AnalysisKind, AnalysisStatus } from '@sales-portal/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../../db/client';
import { analyses } from '../../db/schema';
import { adaptersFor } from '../../integrations';
import type { JobContext } from '../../jobs/registry';
import { toAnalysis } from './analysis';
import type { AiDeps } from './common';

export { countReadyAnalyses, listReviewItems, toAnalysis } from './analysis';
export { deleteBriefingForBooking, onBookingCreated, updateBriefingForBooking } from './briefing';
export type { AiDeps } from './common';
export { onCallSessionEnded } from './transcripts';

export function aiDepsFor(request: FastifyRequest): AiDeps {
  const app = request.server;
  return { config: app.config, db: app.db, adapters: adaptersFor(request), log: request.log, now: app.ctx.now };
}

export function aiDepsFromJob(ctx: Pick<JobContext, 'config' | 'db' | 'adapters' | 'log' | 'now'>): AiDeps {
  return { config: ctx.config, db: ctx.db, adapters: ctx.adapters, log: ctx.log, now: () => ctx.now() };
}

export async function listAnalyses(db: Db, ownerUserId: string, status?: AnalysisStatus, kind?: AnalysisKind): Promise<Analysis[]> {
  const conditions = [eq(analyses.ownerUserId, ownerUserId)];
  if (status) conditions.push(eq(analyses.status, status));
  if (kind) conditions.push(eq(analyses.kind, kind));
  const rows = await db
    .select()
    .from(analyses)
    .where(and(...conditions))
    .orderBy(desc(analyses.createdAt))
    .limit(200);
  return rows.map(toAnalysis);
}
