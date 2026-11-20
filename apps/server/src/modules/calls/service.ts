/**
 * Call sessions (INTENT 6.2, 6.3, 6.15): Wählen → Verbunden → Aufgelegt → Nachbearbeitung, «Nicht erreicht» with one
 * click (the click is the approval), note draft saved continuously on the server, incoming callbacks as session type.
 *
 * OWNER: coldcall implementer. Table `call_sessions`.
 */
import {
  CALL_STATUS,
  EXCLUSION_LABELS,
  normalizePhone,
  RESULT_GROUP_CODES,
  startOfZurichDay,
  nextAttemptAfterNotReached,
  type CallSession,
  type ChangeSet,
  type Lead,
} from '@sales-portal/shared';
import { and, desc, eq, gte, inArray, lt, type InferSelectModel, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { callSessions } from '../../db/schema';
import type { Adapters } from '../../integrations';
import type { DialTarget } from '../../integrations/telephony/types';
import type { AiDeps } from '../ai/common';
import { onCallSessionEnded } from '../ai/service';
import { audit } from '../../lib/audit';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { getSetting } from '../../lib/settings';
import { isAdmin, loadOwnedCall, pushChangeSet, revertChangeSet, upsertDraft, type ChangeSetCtx } from '../changesets/service';

type Row = InferSelectModel<typeof callSessions>;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Dialing / connected sessions older than this are treated as forgotten (moved to wrap-up, nothing is lost). */
const STALE_ACTIVE_MS = 2 * 60 * 60_000;
export const NOTE_MAX_LENGTH = 20_000;

export function toCallSession(r: Row): CallSession {
  return {
    id: r.id,
    userId: r.userId,
    leadId: r.leadId,
    leadName: r.leadName,
    companyName: r.companyName,
    phoneE164: r.phoneE164,
    phoneDisplay: r.phoneDisplay,
    direction: r.direction,
    category: r.category,
    status: r.status,
    reason: r.reason,
    dialedAt: iso(r.dialedAt),
    connectedAt: iso(r.connectedAt),
    endedAt: iso(r.endedAt),
    durationSec: r.durationSec,
    durationSource: r.durationSource ?? null,
    veraEnabled: r.veraEnabled,
    transcriptRef: r.transcriptRef,
    noteDraft: r.noteDraft,
    noteSavedAt: iso(r.noteSavedAt),
    resultGroup: (r.resultGroup as CallSession['resultGroup']) ?? null,
    changeSetId: r.changeSetId,
    crmPhonecallId: r.crmPhonecallId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export interface CallCtx extends ChangeSetCtx {
  adapters: Adapters;
  /** Dependencies for the ai module's «call ended» hook (transcript + analysis in the background). */
  ai?: AiDeps;
}

/** Newest unfinished call of the user (dialing / connected / ended without result), outbound or inbound. */
export async function getActiveCall(db: Db, userId: string): Promise<CallSession | null> {
  const [row] = await db
    .select()
    .from(callSessions)
    .where(and(eq(callSessions.userId, userId), inArray(callSessions.status, ['dialing', 'connected', 'ended'])))
    .orderBy(desc(callSessions.createdAt))
    .limit(1);
  return row ? toCallSession(row) : null;
}

/** «Anrufgrund» shown in the dial bar: Erstkontakt · Rückruf vereinbart · aus Kampagne · neuer Versuch · Folgeanruf. */
export function callReason(lead: Pick<Lead, 'kls_callstatus' | 'campaign' | 'lastRealContact' | 'nextAttemptAt' | 'nextDueAt'>, now: Date): string {
  const parts: string[] = [];
  const callbackCodes: number[] = [CALL_STATUS.CALLBACK_TODAY, CALL_STATUS.CALLBACK_TOMORROW, CALL_STATUS.CALLBACK_7_DAYS, CALL_STATUS.CALLBACK_31_DAYS];
  if (lead.kls_callstatus != null && callbackCodes.includes(lead.kls_callstatus)) parts.push('Rückruf vereinbart');
  else if (lead.kls_callstatus === CALL_STATUS.WAITING || lead.kls_callstatus === CALL_STATUS.MEETING_PROPOSED) parts.push('Nachfassen');
  else if (lead.nextAttemptAt) parts.push('Neuer Versuch');
  else if (!lead.lastRealContact) parts.push('Erstkontakt');
  else parts.push('Folgeanruf');
  if (lead.nextDueAt && Date.parse(lead.nextDueAt) < now.getTime() && !parts.includes('Rückruf vereinbart')) parts.push('Aufgabe fällig');
  if (lead.campaign.fromCampaign) parts.push('aus Kampagne');
  return parts.join(' · ');
}

function pickPhone(lead: Lead, requested?: string | null): { e164: string; display: string } {
  if (requested) {
    const n = normalizePhone(requested);
    if (n.status !== 'ok' || !n.e164) throw unprocessable('Nummer prüfen', 'phone_invalid');
    const own = lead.phones.some((p) => p.e164 === n.e164 || p.candidates.includes(n.e164!));
    if (!own) throw badRequest('Diese Nummer gehört nicht zum Lead');
    return { e164: n.e164, display: n.display ?? n.e164 };
  }
  const p = lead.primaryPhone;
  if (!p?.e164) throw unprocessable('Keine gültige Nummer – Nummer prüfen', 'phone_missing');
  return { e164: p.e164, display: p.display ?? p.e164 };
}

export interface StartCallInput {
  leadId: string;
  direction?: 'outbound' | 'inbound';
  /** Number to dial (one of the lead's numbers) or, inbound, the caller's number. */
  phoneE164?: string | null;
  /** Inbound: shown as reason (e.g. «Rückruf auf Anruf vom 18.11.»). */
  reason?: string | null;
  /** Outbound call of a lead hidden from the call list (campaign lock, Divendo …): admins only, with a reason. */
  override?: { reason: string } | null;
}

/**
 * Why this lead must not be called right now (INTENT 5: campaign lock, Divendo, Zweitkontakt, gleiche Domain,
 * bestehende Firma, geschlossen). Empty → callable. «Nicht mehr kontaktieren» is checked separately (no override).
 */
export function lockReasons(lead: Pick<Lead, 'campaign' | 'exclusions'>): string[] {
  const reasons = new Set<string>(lead.exclusions.filter((e) => e !== 'do_not_contact').map((e) => EXCLUSION_LABELS[e] ?? e));
  if (lead.campaign.locked) reasons.add(EXCLUSION_LABELS.campaign_locked);
  return [...reasons];
}

export async function startCall(ctx: CallCtx, input: StartCallInput): Promise<{ call: CallSession; dial: DialTarget | null; resumed: boolean }> {
  const lead = await ctx.crm.getLead(input.leadId);
  if (!lead) throw notFound('Lead nicht gefunden');
  const direction = input.direction ?? 'outbound';
  const now = ctx.now();
  const userId = ctx.auth.user.id;

  // One running call per person.
  const running = await ctx.db
    .select()
    .from(callSessions)
    .where(and(eq(callSessions.userId, userId), inArray(callSessions.status, ['dialing', 'connected'])))
    .orderBy(desc(callSessions.createdAt));
  for (const r of running) {
    const stale = now.getTime() - r.createdAt.getTime() > STALE_ACTIVE_MS;
    if (stale || (direction === 'inbound' && r.status === 'dialing' && r.leadId !== input.leadId)) {
      // Forgotten / unanswered call: into the wrap-up list (Pendenzen «Unabgeschlossene Anrufe»), nothing is lost.
      await ctx.db
        .update(callSessions)
        .set({ status: 'ended', endedAt: r.endedAt ?? now, updatedAt: now })
        .where(eq(callSessions.id, r.id));
      continue;
    }
    if (r.leadId === input.leadId && r.direction === direction) {
      return { call: toCallSession(r), dial: direction === 'outbound' && r.phoneE164 ? ctx.adapters.telephony.dialTarget(r.phoneE164) : null, resumed: true };
    }
    throw new AppError(409, 'call_active', `Es läuft noch ein Anruf mit ${r.companyName ?? 'einem anderen Lead'} – zuerst abschliessen`, { callId: r.id });
  }

  let phone: { e164: string; display: string } | null;
  let dial: DialTarget | null = null;
  if (direction === 'outbound') {
    if (lead.donotphone || lead.kls_callstatus === CALL_STATUS.DO_NOT_CONTACT) throw unprocessable('Dieser Lead möchte nicht angerufen werden', 'do_not_phone');
    const locked = lockReasons(lead);
    if (locked.length) {
      if (!input.override) {
        throw new AppError(422, 'lead_locked', `Dieser Lead ist gesperrt: ${locked.join(' · ')}`, { reasons: locked });
      }
      if (!isAdmin(ctx.auth)) throw forbidden('Einen gesperrten Lead gibt nur der Admin frei');
      await audit(ctx.db, {
        actor: ctx.auth.actor,
        action: 'call.locked_override',
        entity: 'lead',
        entityId: lead.leadid,
        newValue: input.override.reason,
        meta: { reasons: locked },
      });
    }
    phone = pickPhone(lead, input.phoneE164);
    dial = ctx.adapters.telephony.dialTarget(phone.e164);
  } else {
    const n = input.phoneE164 ? normalizePhone(input.phoneE164) : null;
    phone = n?.status === 'ok' && n.e164 ? { e164: n.e164, display: n.display ?? n.e164 } : lead.primaryPhone?.e164 ? { e164: lead.primaryPhone.e164, display: lead.primaryPhone.display ?? lead.primaryPhone.e164 } : null;
  }

  const [row] = await ctx.db
    .insert(callSessions)
    .values({
      userId,
      leadId: lead.leadid,
      leadName: lead.fullname,
      companyName: lead.companyname,
      phoneE164: phone?.e164 ?? null,
      phoneDisplay: phone?.display ?? null,
      direction,
      category: direction === 'outbound' ? 'outbound' : 'callback_answered',
      status: direction === 'outbound' ? 'dialing' : 'connected',
      reason: direction === 'outbound' ? callReason(lead, now) : input.reason?.trim().slice(0, 200) || 'Rückruf angenommen',
      dialedAt: now,
      connectedAt: direction === 'inbound' ? now : null,
      veraEnabled: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { call: toCallSession(row), dial, resumed: false };
}

async function loadForUpdate(ctx: CallCtx, id: string): Promise<Row> {
  const row = await loadOwnedCall(ctx, id);
  if (row.userId !== ctx.auth.user.id) throw forbidden('Nur die anrufende Person kann den Anruf bedienen');
  return row;
}

export async function getCall(ctx: CallCtx, id: string): Promise<CallSession> {
  return toCallSession(await loadOwnedCall(ctx, id));
}

/** «Verbunden» (idempotent). */
export async function markConnected(ctx: CallCtx, id: string): Promise<CallSession> {
  const row = await loadForUpdate(ctx, id);
  if (row.status === 'connected') return toCallSession(row);
  if (row.status !== 'dialing') throw conflict('Der Anruf läuft nicht mehr');
  const now = ctx.now();
  const [updated] = await ctx.db.update(callSessions).set({ status: 'connected', connectedAt: now, updatedAt: now }).where(eq(callSessions.id, id)).returning();
  return toCallSession(updated);
}

/** «Aufgelegt» → Nachbearbeitung. Duration from the clicks (Vera may override later, ai module). */
export async function hangUp(ctx: CallCtx, id: string): Promise<CallSession> {
  const row = await loadForUpdate(ctx, id);
  if (row.status === 'ended') return toCallSession(row);
  if (row.status !== 'connected') throw conflict(row.status === 'dialing' ? 'Zuerst «Verbunden» oder «Nicht erreicht» wählen' : 'Der Anruf läuft nicht mehr');
  const now = ctx.now();
  const durationSec = row.connectedAt ? Math.max(0, Math.round((now.getTime() - row.connectedAt.getTime()) / 1000)) : null;
  const [updated] = await ctx.db
    .update(callSessions)
    .set({ status: 'ended', endedAt: now, durationSec, durationSource: 'clicks', updatedAt: now })
    .where(eq(callSessions.id, id))
    .returning();
  // KI-Analyse im Hintergrund (INTENT 6.4, ai module): Vera on → transcript → analysis. Never blocks «Aufgelegt»;
  // the ai module's recurring sweep picks the call up if this hook fails.
  if (row.veraEnabled && ctx.ai) {
    await onCallSessionEnded(ctx.ai, id).catch((err: unknown) =>
      ctx.ai?.log.warn({ callSessionId: id, err: { message: err instanceof Error ? err.message : String(err) } }, 'call-ended hook failed'),
    );
  }
  return toCallSession(updated);
}

export interface NotReachedResponse {
  call: CallSession;
  changeSet: ChangeSet;
  status: ChangeSet['status'];
  /** Next attempt (never in the same half-day). */
  nextAttemptAt: string;
  /** «Nicht erreicht» in the last N days (incl. this one) and whether to propose a use-case mail (6.5 / 6.7). */
  attempts: number;
  windowDays: number;
  suggestMail: boolean;
}

/** «Nicht erreicht»: one click saves phone call + call status (the click is the approval) and ends the session. */
export async function notReached(ctx: CallCtx, id: string): Promise<NotReachedResponse> {
  const row = await loadForUpdate(ctx, id);
  if (row.status !== 'dialing') throw conflict(row.status === 'connected' ? 'Der Anruf ist verbunden – bitte «Aufgelegt» und ein Ergebnis wählen' : 'Der Anruf ist schon abgeschlossen');
  if (!row.leadId) throw badRequest('Anruf ohne Lead');
  const now = ctx.now();
  // Atomic «wählt → Nachbearbeitung»: a second click / key repeat finds the call no longer dialing (409) and never
  // builds a second «Nicht erreicht» (two phone calls in the CRM would trigger the 3×-mail hint too early).
  const [claimed] = await ctx.db
    .update(callSessions)
    .set({ status: 'ended', endedAt: now, updatedAt: now })
    .where(and(eq(callSessions.id, id), eq(callSessions.status, 'dialing')))
    .returning({ id: callSessions.id });
  if (!claimed) throw conflict('«Nicht erreicht» wird schon gespeichert', 'not_reached_running');

  let draftId: string;
  try {
    const draft = await upsertDraft(ctx, { leadId: row.leadId, callSessionId: id, ruleKey: 'not_reached', input: {} });
    if (!draft.changeSet) throw unprocessable(draft.issues.map((i) => i.message).join(' · ') || 'Nicht erreicht konnte nicht vorbereitet werden');
    draftId = draft.changeSet.id;
  } catch (err) {
    // Nothing was written: the call is dialing again, as before the click.
    await ctx.db
      .update(callSessions)
      .set({ status: 'dialing', endedAt: null, updatedAt: ctx.now() })
      .where(and(eq(callSessions.id, id), eq(callSessions.status, 'ended')));
    throw err;
  }
  const pushed = await pushChangeSet(ctx, draftId, {});
  if (pushed.status !== 'pushed') {
    // Conflict or CRM error: the session waits in the wrap-up (Pendenzen «Unabgeschlossene Anrufe»).
    await ctx.db.update(callSessions).set({ status: 'ended', resultGroup: 'not_reached', changeSetId: pushed.changeSet.id, updatedAt: now }).where(eq(callSessions.id, id));
  }

  const threshold = await getSetting(ctx.db, 'calls.notReachedMailThreshold');
  const from = new Date(now.getTime() - threshold.withinDays * 86_400_000).toISOString();
  const calls = await ctx.crm.listPhoneCalls({ leadId: row.leadId, from, resultCodes: [RESULT_GROUP_CODES.not_reached], limit: 100 });
  const attempts = calls.length;
  const [updated] = await ctx.db.select().from(callSessions).where(eq(callSessions.id, id));
  return {
    call: toCallSession(updated),
    changeSet: pushed.changeSet,
    status: pushed.status,
    nextAttemptAt: nextAttemptAfterNotReached(now).toISOString(),
    attempts,
    windowDays: threshold.withinDays,
    suggestMail: attempts >= threshold.attempts,
  };
}

/** «Rückgängig» after «Nicht erreicht»: CRM change undone, the call is back to «wählt». */
export async function undoNotReached(ctx: CallCtx, id: string): Promise<{ call: CallSession; skipped: string[] }> {
  const row = await loadForUpdate(ctx, id);
  if (row.resultGroup !== 'not_reached' || !row.changeSetId) throw conflict('Hier gibt es nichts rückgängig zu machen');
  let skipped: string[] = [];
  if (row.status === 'not_reached') {
    const res = await revertChangeSet(ctx, row.changeSetId, { reason: 'Nicht erreicht rückgängig' });
    skipped = res.skipped.map((s) => s.label);
  }
  const now = ctx.now();
  const [updated] = await ctx.db
    .update(callSessions)
    .set({ status: 'dialing', endedAt: null, resultGroup: null, changeSetId: null, crmPhonecallId: null, updatedAt: now })
    .where(eq(callSessions.id, id))
    .returning();
  return { call: toCallSession(updated), skipped };
}

/** Debounced autosave of the note («Nichts geht verloren»). */
export async function saveNote(ctx: CallCtx, id: string, note: string): Promise<{ noteSavedAt: string }> {
  const row = await loadForUpdate(ctx, id);
  if (row.status === 'completed' || row.status === 'abandoned') throw conflict('Der Anruf ist abgeschlossen – die Notiz ist schon im CRM');
  if (row.status === 'not_reached') throw conflict('Nicht erreicht ist schon gespeichert');
  const now = ctx.now();
  await ctx.db.update(callSessions).set({ noteDraft: note.slice(0, NOTE_MAX_LENGTH), noteSavedAt: now, updatedAt: now }).where(eq(callSessions.id, id));
  return { noteSavedAt: now.toISOString() };
}

/** Vera on/off for this call (person did not agree to the transcription, StGB 179ter). */
export async function setVera(ctx: CallCtx, id: string, enabled: boolean): Promise<CallSession> {
  const row = await loadForUpdate(ctx, id);
  if (row.status === 'completed' || row.status === 'abandoned') throw conflict('Der Anruf ist abgeschlossen');
  const [updated] = await ctx.db.update(callSessions).set({ veraEnabled: enabled, updatedAt: ctx.now() }).where(eq(callSessions.id, id)).returning();
  await audit(ctx.db, { actor: ctx.auth.actor, action: enabled ? 'call.vera_on' : 'call.vera_off', entity: 'call_session', entityId: id, field: 'vera_enabled', oldValue: row.veraEnabled, newValue: enabled });
  return toCallSession(updated);
}

/** Abort a call that never started (wrong lead clicked). Calls with a conversation cannot be discarded. */
export async function abandonCall(ctx: CallCtx, id: string): Promise<CallSession> {
  const row = await loadForUpdate(ctx, id);
  if (row.status !== 'dialing') throw conflict('Nur ein Anruf, der noch wählt, kann abgebrochen werden');
  const [updated] = await ctx.db.update(callSessions).set({ status: 'abandoned', endedAt: ctx.now(), updatedAt: ctx.now() }).where(eq(callSessions.id, id)).returning();
  return toCallSession(updated);
}

/**
 * Unfinished calls for the Pendenzen («kein Anruf bleibt ohne CRM-Eintrag liegen»): dialing, connected or ended
 * without a pushed result. Only admins may list other people's calls.
 */
export async function listCalls(
  ctx: Pick<CallCtx, 'db' | 'auth' | 'now'>,
  q: { scope?: 'unfinished' | 'recent'; userId?: string; all?: boolean; leadId?: string; limit?: number },
): Promise<CallSession[]> {
  const conditions: SQL[] = [];
  if (q.all || (q.userId && q.userId !== ctx.auth.user.id)) {
    if (!isAdmin(ctx.auth)) throw forbidden('Nur Admins sehen Anrufe anderer Personen');
    if (q.userId) conditions.push(eq(callSessions.userId, q.userId));
  } else conditions.push(eq(callSessions.userId, ctx.auth.user.id));
  if ((q.scope ?? 'unfinished') === 'unfinished') conditions.push(inArray(callSessions.status, ['dialing', 'connected', 'ended']));
  if (q.leadId) conditions.push(eq(callSessions.leadId, q.leadId));
  const rows = await ctx.db
    .select()
    .from(callSessions)
    .where(and(...conditions))
    .orderBy(desc(callSessions.createdAt))
    .limit(Math.min(q.limit ?? 100, 500));
  return rows.map(toCallSession);
}

export interface TodayProgress {
  /** Outbound calls dialed today (Zurich day), aborted ones not counted. */
  calls: number;
  /** Calls with a conversation (connected), outbound and answered callbacks. */
  conversations: number;
  /** «Nicht erreicht» today. */
  notReached: number;
}

/** Daily progress of the current user (INTENT 4 step 1 «Tagesziel»), from the portal's call sessions. */
export async function todayProgress(ctx: Pick<CallCtx, 'db' | 'auth' | 'now'>): Promise<TodayProgress> {
  const from = startOfZurichDay(ctx.now());
  const rows = await ctx.db
    .select({ status: callSessions.status, direction: callSessions.direction, connectedAt: callSessions.connectedAt })
    .from(callSessions)
    .where(and(eq(callSessions.userId, ctx.auth.user.id), gte(callSessions.createdAt, from)));
  const counted = rows.filter((r) => r.status !== 'abandoned');
  return {
    calls: counted.filter((r) => r.direction === 'outbound').length,
    conversations: counted.filter((r) => r.connectedAt != null).length,
    notReached: counted.filter((r) => r.status === 'not_reached').length,
  };
}

/** Calls still dialing / connected after a long time are moved to the wrap-up list (recurring job). */
export async function sweepStaleCalls(db: Db, now: Date): Promise<number> {
  const before = new Date(now.getTime() - STALE_ACTIVE_MS);
  // Into the wrap-up (status «ended»), never discarded: the caller still picks a result (e.g. «Nicht erreicht»).
  const rows = await db
    .update(callSessions)
    .set({ status: 'ended', endedAt: now, updatedAt: now })
    .where(and(inArray(callSessions.status, ['dialing', 'connected']), lt(callSessions.createdAt, before)))
    .returning({ id: callSessions.id });
  return rows.length;
}

