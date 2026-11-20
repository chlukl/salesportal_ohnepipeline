/**
 * Transcript flow (INTENT 6.3, 6.4 step 2):
 *
 *   call ended with Vera on → analysis row `pending` + job `ai.fetch_transcript`
 *   → poll Vera until the transcript is there (or the timeout setting passes → analysis `skipped`, silently)
 *   → store transcript (delete_after = now + retention days; never written to the CRM)
 *   → background duration/start/end on the call session + CRM phone call (no approval, INTENT 5 exception)
 *   → job `ai.analyze_call`
 *
 * Entry points: `onCallSessionEnded()` (for the calls module) and the recurring sweep (safety net, finds ended calls
 * without analysis), plus the optional Vera webhook.
 */
import type { CallSession, Transcript } from '@sales-portal/shared';
import { and, eq, gte, inArray, isNotNull, isNull, sql, type InferSelectModel } from 'drizzle-orm';
import { analyses, callSessions, transcripts, users } from '../../db/schema';
import { enqueueJob } from '../../jobs/queue';
import { audit } from '../../lib/audit';
import { getSetting } from '../../lib/settings';
import { SYSTEM_ACTOR, type AiDeps } from './common';

export const JOB_FETCH_TRANSCRIPT = 'ai.fetch_transcript';
export const JOB_ANALYZE_CALL = 'ai.analyze_call';
export const JOB_SYNC_DURATION = 'ai.sync_call_duration';

/** Poll interval while Vera is still processing. */
const POLL_MS = { mock: 10_000, live: 60_000 };
/** Give up updating the CRM phone call duration when the call result was not pushed within this time. */
const DURATION_SYNC_MAX_MS = 24 * 3600_000;
const DURATION_SYNC_RETRY_MS = 2 * 60_000;

type CallRow = InferSelectModel<typeof callSessions>;
type TranscriptRow = InferSelectModel<typeof transcripts>;

export function toTranscript(r: TranscriptRow): Transcript {
  return {
    id: r.id,
    callSessionId: r.callSessionId,
    leadId: r.leadId,
    source: r.source,
    externalRef: r.externalRef,
    startedAt: r.startedAt?.toISOString() ?? null,
    endedAt: r.endedAt?.toISOString() ?? null,
    durationSec: r.durationSec,
    segments: r.segments,
    fetchedAt: r.fetchedAt.toISOString(),
    deleteAfter: r.deleteAfter.toISOString(),
  };
}

/** Status of the call for which the transcript flow starts. */
const ENDED_STATUSES: CallSession['status'][] = ['ended', 'completed'];

export function isAnalyzableCall(c: Pick<CallRow, 'veraEnabled' | 'endedAt' | 'leadId' | 'status' | 'connectedAt'>): boolean {
  return c.veraEnabled && !!c.endedAt && !!c.leadId && !!c.connectedAt && ENDED_STATUSES.includes(c.status);
}

/** Deadline after which the analysis is dropped (setting `analysis.timeoutMinutes`, default 30). */
export function transcriptDeadline(endedAt: Date, timeoutMinutes: number): Date {
  return new Date(endedAt.getTime() + timeoutMinutes * 60_000);
}

/**
 * Start the transcript flow for an ended call (idempotent). Called by the calls module after «Aufgelegt»
 * and by the sweep. Vera off / not connected / no lead → nothing happens (the note stays, no analysis).
 */
export async function onCallSessionEnded(deps: AiDeps, callSessionId: string): Promise<string | null> {
  const [call] = await deps.db.select().from(callSessions).where(eq(callSessions.id, callSessionId));
  if (!call || !isAnalyzableCall(call)) return null;
  const [existing] = await deps.db
    .select({ id: analyses.id })
    .from(analyses)
    .where(and(eq(analyses.kind, 'call'), eq(analyses.callSessionId, callSessionId)));
  if (existing) return existing.id;
  const [row] = await deps.db
    .insert(analyses)
    .values({ kind: 'call', leadId: call.leadId!, callSessionId, ownerUserId: call.userId, status: 'pending' })
    .returning({ id: analyses.id });
  await enqueueJob(deps.db, JOB_FETCH_TRANSCRIPT, { analysisId: row.id }, { dedupeKey: `${JOB_FETCH_TRANSCRIPT}:${row.id}` });
  return row.id;
}

/** Recurring safety net: ended calls (within the timeout window) that have no analysis row yet. */
export async function sweepEndedCalls(deps: AiDeps): Promise<number> {
  const timeout = await getSetting(deps.db, 'analysis.timeoutMinutes');
  const since = new Date(deps.now().getTime() - timeout * 60_000);
  const rows = await deps.db
    .select({ id: callSessions.id })
    .from(callSessions)
    .leftJoin(analyses, and(eq(analyses.callSessionId, callSessions.id), eq(analyses.kind, 'call')))
    .where(
      and(
        eq(callSessions.veraEnabled, true),
        isNotNull(callSessions.endedAt),
        isNotNull(callSessions.connectedAt),
        gte(callSessions.endedAt, since),
        inArray(callSessions.status, ENDED_STATUSES),
        isNull(analyses.id),
      ),
    )
    .limit(50);
  for (const r of rows) await onCallSessionEnded(deps, r.id);
  return rows.length;
}

async function setAnalysis(deps: AiDeps, id: string, set: Partial<InferSelectModel<typeof analyses>>): Promise<void> {
  await deps.db.update(analyses).set({ ...set, updatedAt: deps.now() }).where(eq(analyses.id, id));
}

/** Drop the analysis silently (INTENT 6.4: no transcript → it stays with the note). */
async function skip(deps: AiDeps, analysisId: string, reason: string): Promise<void> {
  await setAnalysis(deps, analysisId, { status: 'skipped', error: reason });
  deps.log.info({ analysisId, reason }, 'call analysis skipped');
}

/** Job `ai.fetch_transcript`. Returns what happened (for tests). */
export async function fetchTranscriptJob(deps: AiDeps, analysisId: string): Promise<'stored' | 'pending' | 'skipped' | 'noop'> {
  const [analysis] = await deps.db.select().from(analyses).where(eq(analyses.id, analysisId));
  if (!analysis || analysis.status !== 'pending' || !analysis.callSessionId) return 'noop';
  const [call] = await deps.db.select().from(callSessions).where(eq(callSessions.id, analysis.callSessionId));
  if (!call || !call.endedAt) {
    await skip(deps, analysisId, 'Anruf nicht gefunden');
    return 'skipped';
  }
  if (!call.veraEnabled) {
    await skip(deps, analysisId, 'Vera war ausgeschaltet');
    return 'skipped';
  }
  const timeout = await getSetting(deps.db, 'analysis.timeoutMinutes');
  const deadline = transcriptDeadline(call.endedAt, timeout);
  const now = deps.now();
  if (now >= deadline) {
    await skip(deps, analysisId, 'Kein Transkript innerhalb der Frist');
    return 'skipped';
  }

  const [user] = await deps.db.select({ email: users.email }).from(users).where(eq(users.id, call.userId));
  let fetched;
  try {
    fetched = await deps.adapters.transcripts.fetchTranscript({
      callSessionId: call.id,
      externalRef: call.transcriptRef,
      phoneE164: call.phoneE164,
      startedAt: (call.connectedAt ?? call.dialedAt)?.toISOString() ?? null,
      endedAt: call.endedAt.toISOString(),
      userEmail: user?.email ?? '',
    });
  } catch (err) {
    deps.log.warn({ analysisId, err: { message: err instanceof Error ? err.message : String(err) } }, 'transcript fetch failed');
    fetched = { status: 'pending' as const };
  }

  if (fetched.status === 'unavailable') {
    await skip(deps, analysisId, fetched.reason);
    return 'skipped';
  }
  if (fetched.status === 'pending') {
    const poll = POLL_MS[deps.adapters.transcripts.mode];
    const runAt = new Date(Math.min(now.getTime() + poll, deadline.getTime()));
    // No dedupe key: the currently running job still holds it.
    await enqueueJob(deps.db, JOB_FETCH_TRANSCRIPT, { analysisId }, { runAt, maxAttempts: 3 });
    return 'pending';
  }

  const retentionDays = await getSetting(deps.db, 'transcripts.retentionDays');
  const t = fetched.transcript;
  const [stored] = await deps.db
    .insert(transcripts)
    .values({
      callSessionId: call.id,
      leadId: call.leadId,
      source: t.source,
      externalRef: t.externalRef,
      language: 'de',
      segments: t.segments,
      startedAt: t.startedAt ? new Date(t.startedAt) : null,
      endedAt: t.endedAt ? new Date(t.endedAt) : null,
      durationSec: t.durationSec,
      fetchedAt: now,
      deleteAfter: new Date(now.getTime() + retentionDays * 86_400_000),
    })
    .returning({ id: transcripts.id });

  // Duration from Vera wins over the clicks (INTENT 6.3) – background, no lead fields, no approval.
  const veraDuration = t.durationSec ?? (t.startedAt && t.endedAt ? Math.round((Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 1000) : null);
  if (veraDuration != null) {
    await deps.db
      .update(callSessions)
      .set({ durationSec: veraDuration, durationSource: 'vera', transcriptRef: call.transcriptRef ?? t.externalRef, updatedAt: now })
      .where(eq(callSessions.id, call.id));
    await enqueueJob(deps.db, JOB_SYNC_DURATION, { callSessionId: call.id, transcriptId: stored.id }, { dedupeKey: `${JOB_SYNC_DURATION}:${call.id}` });
  }

  await setAnalysis(deps, analysisId, { transcriptId: stored.id, status: 'running', error: null });
  await enqueueJob(deps.db, JOB_ANALYZE_CALL, { analysisId }, { dedupeKey: `${JOB_ANALYZE_CALL}:${analysisId}`, maxAttempts: 3 });
  await audit(deps.db, { actor: 'system', action: 'ai.transcript_stored', entity: 'transcript', entityId: stored.id, meta: { callSessionId: call.id, source: t.source } });
  return 'stored';
}

/**
 * Job `ai.sync_call_duration`: write Vera's start/end/duration to the CRM phone call. Waits (re-enqueues) until the
 * call result was pushed and the phone call id is known; gives up after 24 h.
 */
export async function syncCallDurationJob(deps: AiDeps, callSessionId: string, transcriptId: string): Promise<'updated' | 'waiting' | 'noop'> {
  const [call] = await deps.db.select().from(callSessions).where(eq(callSessions.id, callSessionId));
  const [t] = await deps.db.select().from(transcripts).where(eq(transcripts.id, transcriptId));
  if (!call || !t || !call.endedAt) return 'noop';
  if (!call.crmPhonecallId) {
    if (deps.now().getTime() - call.endedAt.getTime() > DURATION_SYNC_MAX_MS) return 'noop';
    await enqueueJob(deps.db, JOB_SYNC_DURATION, { callSessionId, transcriptId }, { runAt: new Date(deps.now().getTime() + DURATION_SYNC_RETRY_MS) });
    return 'waiting';
  }
  const durationSec = t.durationSec ?? call.durationSec;
  await deps.adapters.crm.updatePhoneCall(
    call.crmPhonecallId,
    {
      start: t.startedAt?.toISOString() ?? undefined,
      end: t.endedAt?.toISOString() ?? undefined,
      durationSec: durationSec ?? undefined,
    },
    SYSTEM_ACTOR,
  );
  await audit(deps.db, {
    actor: 'system',
    action: 'crm.phonecall_duration',
    entity: 'phonecall',
    entityId: call.crmPhonecallId,
    field: 'actualdurationminutes',
    newValue: durationSec,
    meta: { callSessionId, source: 'vera' },
  });
  return 'updated';
}

/** Recent transcript of a call (for the analysis job). */
export async function loadTranscript(deps: AiDeps, transcriptId: string | null): Promise<Transcript | null> {
  if (!transcriptId) return null;
  const [row] = await deps.db.select().from(transcripts).where(eq(transcripts.id, transcriptId));
  return row ? toTranscript(row) : null;
}

/** Match a Vera notification to a portal call: same user, call time within ±10 minutes, Vera on. */
export async function matchCallSession(deps: AiDeps, userEmail: string, startedAt: Date): Promise<string | null> {
  const windowMs = 10 * 60_000;
  const rows = await deps.db
    .select({ id: callSessions.id, connectedAt: callSessions.connectedAt, dialedAt: callSessions.dialedAt })
    .from(callSessions)
    .innerJoin(users, eq(users.id, callSessions.userId))
    .where(
      and(
        eq(users.email, userEmail.toLowerCase()),
        eq(callSessions.veraEnabled, true),
        sql`coalesce(${callSessions.connectedAt}, ${callSessions.dialedAt}) between ${new Date(startedAt.getTime() - windowMs).toISOString()}::timestamptz and ${new Date(startedAt.getTime() + windowMs).toISOString()}::timestamptz`,
      ),
    );
  const best = rows
    .map((r) => ({ id: r.id, diff: Math.abs((r.connectedAt ?? r.dialedAt ?? new Date(0)).getTime() - startedAt.getTime()) }))
    .sort((a, b) => a.diff - b.diff)[0];
  return best?.id ?? null;
}
