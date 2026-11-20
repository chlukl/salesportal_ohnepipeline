/**
 * Call analysis and «Analysen zur Freigabe» (INTENT 6.4, 6.9 «Zwei Stufen»).
 *
 * - Job `ai.analyze_call`: budget check → AI → zod-validated result → status `ready` + draft change set (kind `analysis`)
 *   with the base snapshot of every proposed field (for the conflict check at approval time).
 * - Draft = one phone-call update (summary + kls_interesse, always applied on «Ergänzen») plus optional proposals
 *   (other result group, decision maker, field changes, new contact person) that Markus ticks explicitly (alt → neu).
 * - Approve → push via CrmAdapter.applyChangeSet (push.ts) → analysis `approved` → briefing of future bookings rebuilt.
 * - Dismiss → analysis `rejected`, draft discarded. The AI never writes anything on its own.
 */
import {
  optionLabel,
  RESULT_GROUP_CODES,
  RESULT_GROUP_LABELS,
  resultGroupByCode,
  zurichDayDiff,
  type ActivityOp,
  type Analysis,
  type CallAnalysis,
  type ChangeSet,
  type Conflict,
  type FieldOp,
  type Lead,
  type LeadCreateOp,
  type ResultGroupRule,
  normalizePhone,
  samePhone,
  toCrmPhone,
} from '@sales-portal/shared';
import { and, desc, eq, gt, inArray, isNull, type InferSelectModel } from 'drizzle-orm';
import type { RequestAuth } from '../../auth/rbac';
import { analyses, bookings, callSessions, changeSets } from '../../db/schema';
import { enqueueJob } from '../../jobs/queue';
import { audit } from '../../lib/audit';
import { AppError, conflict, notFound } from '../../lib/errors';
import { budgetExceededError, budgetStatus } from './budget';
import { activeRuleDefinitions, assertOwnerOrAdmin, loadAiContext, type AiDeps } from './common';
import { pushChangeSet, rowToChangeSet, snapshotKeyOf, type ChangeSetRow } from './push';
import { loadTranscript } from './transcripts';

export const JOB_BUILD_BRIEFING = 'ai.build_briefing';

type AnalysisRow = InferSelectModel<typeof analyses>;
type CallRow = InferSelectModel<typeof callSessions>;

export const INTEREST_LABELS = ['kein Interesse', 'schwach', 'offen', 'klar'] as const;
export const SUMMARY_MARKER = 'KI-Zusammenfassung:';

export function toAnalysis(r: AnalysisRow): Analysis {
  return {
    id: r.id,
    kind: r.kind,
    leadId: r.leadId,
    callSessionId: r.callSessionId,
    bookingId: r.bookingId,
    transcriptId: r.transcriptId,
    status: r.status,
    model: r.model,
    result: r.result ?? null,
    changeSetId: r.changeSetId,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
  };
}

/** Phone-call text = existing text (note) + approved AI summary. Idempotent: an earlier summary is replaced. */
export function composeCallText(existing: string | null, analysis: Pick<CallAnalysis, 'summary' | 'interest'>): string {
  const base = (existing ?? '').split(SUMMARY_MARKER)[0].trimEnd();
  const block = `${SUMMARY_MARKER} ${analysis.summary.trim()}\nInteresse: ${analysis.interest.level} – ${INTEREST_LABELS[analysis.interest.level]}`;
  return base ? `${base}\n\n${block}` : block;
}

// ---------------------------------------------------------------------------------------------------------------------
// Proposals (alt → neu)
// ---------------------------------------------------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  kls_callstatus: 'Anrufstatus',
  kls_rating_category: 'Bewertung',
  numberofemployees: 'Mitarbeitende',
  decisionmaker: 'Entscheider',
  jobtitle: 'Funktion',
  emailaddress1: 'E-Mail',
  telephone1: 'Telefon',
  mobilephone: 'Mobile',
  kls_anrufergebnis: 'Ergebnis des Anrufs',
};

function display(field: string, value: unknown): string | null {
  if (value == null || value === '') return null;
  if (field === 'kls_callstatus' || field === 'kls_rating_category' || field === 'kls_anrufergebnis') return optionLabel(field, Number(value));
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  return String(value);
}

/** Phone fields: always written in the uniform format (INTENT 6.19); anything not cleanly parseable is dropped. */
const PHONE_FIELDS = new Set(['telephone1', 'mobilephone', 'telephone2', 'telephone3']);
const EMAIL_FIELDS = new Set(['emailaddress1', 'emailaddress2', 'emailaddress3']);
/** Same check as the wrap-up form (shared resultGroups). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Valid e-mail (trimmed, domain lower-cased) or null. */
export function cleanEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > 254 || !EMAIL_RE.test(s)) return null;
  const at = s.lastIndexOf('@');
  return `${s.slice(0, at)}@${s.slice(at + 1).toLowerCase()}`;
}

/** AI value → CRM value. null = drop the proposal (empty, unparseable or invalid). */
export function coerce(field: string, value: unknown): unknown {
  if (value == null) return null;
  if (field === 'decisionmaker') return value === true || value === 'true' || value === 'ja' || value === 'Ja';
  if (field === 'numberofemployees' || field === 'kls_callstatus' || field === 'kls_rating_category') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  if (PHONE_FIELDS.has(field)) {
    const n = normalizePhone(String(value));
    return n.status === 'ok' ? toCrmPhone(n) : null;
  }
  if (EMAIL_FIELDS.has(field)) return cleanEmail(value);
  return String(value).trim() || null;
}

/** True if the proposal would not change anything (same number in another format, same address in other case). */
function unchanged(field: string, oldValue: unknown, value: unknown): boolean {
  if (value === oldValue) return true;
  if (PHONE_FIELDS.has(field)) return typeof oldValue === 'string' && samePhone(oldValue, String(value));
  if (EMAIL_FIELDS.has(field)) return typeof oldValue === 'string' && oldValue.trim().toLowerCase() === String(value).toLowerCase();
  return false;
}

/** Call status for a «by date» rule (INTENT 6.5 Rückruf): first step whose maxDays covers the date. */
export function callStatusForRule(rule: ResultGroupRule, nextStepDate: string | null, now: Date): number | null {
  const cs = rule.callStatus;
  if (cs.mode === 'fixed') return cs.value ?? null;
  if (cs.mode !== 'by_date' || !cs.byDate?.length || !nextStepDate) return null;
  const days = zurichDayDiff(now, `${nextStepDate}T12:00:00Z`);
  return cs.byDate.find((s) => s.maxDays == null || days <= s.maxDays)?.value ?? null;
}

export interface ProposalInput {
  analysis: CallAnalysis;
  lead: Lead;
  call: { resultGroup: string | null; crmPhonecallId: string | null; resultCode?: number | null };
  rules: Map<string, ResultGroupRule>;
  now: Date;
}

export interface Proposals {
  operations: FieldOp[];
  leadCreates: LeadCreateOp[];
  baseSnapshot: Record<string, unknown>;
}

/** Everything the AI proposes beyond the summary, as field ops with alt → neu (nothing selected by default). */
export function buildProposals({ analysis, lead, call, rules, now }: ProposalInput): Proposals {
  const ops = new Map<string, FieldOp>();
  const snapshot: Record<string, unknown> = {};
  const leadValue = (field: string) => (lead as unknown as Record<string, unknown>)[field] ?? null;

  const addLeadOp = (field: string, newValue: unknown, why: string) => {
    if (ops.has(`lead:${field}`)) return;
    const oldValue = leadValue(field);
    const value = coerce(field, newValue);
    if (value == null || unchanged(field, oldValue, value)) return;
    ops.set(`lead:${field}`, {
      id: `ai-lead-${field}`,
      entity: 'lead',
      entityId: lead.leadid,
      field,
      label: `${FIELD_LABELS[field] ?? field} (${why})`,
      oldValue,
      newValue: value,
      mode: 'set',
      oldDisplay: display(field, oldValue),
      newDisplay: display(field, value),
    });
    snapshot[snapshotKeyOf('lead', lead.leadid, field)] = oldValue;
  };

  // 1. Different result group → kls_anrufergebnis on the phone call + call status / rating of that rule.
  const suggested = analysis.suggestion.resultGroup;
  if (suggested && suggested !== call.resultGroup && suggested !== 'not_reached' && suggested !== 'wrong_number') {
    const rule = rules.get(suggested);
    if (call.crmPhonecallId) {
      const oldCode = call.resultCode ?? (call.resultGroup ? (RESULT_GROUP_CODES as Record<string, number>)[call.resultGroup] ?? null : null);
      const newCode = rule?.anrufergebnis ?? RESULT_GROUP_CODES[suggested];
      ops.set('phonecall:kls_anrufergebnis', {
        id: 'ai-call-result',
        entity: 'phonecall',
        entityId: call.crmPhonecallId,
        field: 'kls_anrufergebnis',
        label: `${FIELD_LABELS.kls_anrufergebnis} (KI: ${RESULT_GROUP_LABELS[suggested]})`,
        oldValue: oldCode,
        newValue: newCode,
        mode: 'set',
        oldDisplay: oldCode != null ? (RESULT_GROUP_LABELS[resultGroupByCode(oldCode) ?? suggested] ?? display('kls_anrufergebnis', oldCode)) : null,
        newDisplay: RESULT_GROUP_LABELS[suggested],
      });
      snapshot[snapshotKeyOf('phonecall', call.crmPhonecallId, 'kls_anrufergebnis')] = oldCode;
    }
    // Booking groups set their call status with the booking itself, not from a proposal.
    if (rule && rule.followUp.type !== 'booking') {
      const status = callStatusForRule(rule, analysis.suggestion.nextStepDate, now);
      if (status != null) addLeadOp('kls_callstatus', status, `Ergebnis ${RESULT_GROUP_LABELS[suggested]}`);
      const rating = rule.ratingCategory;
      const ratingApplies =
        rating && (!rating.condition || rating.condition.kind === 'always' || (rating.condition.kind === 'interest_gte' && analysis.interest.level >= rating.condition.value));
      if (rating && ratingApplies) addLeadOp('kls_rating_category', rating.value, `Ergebnis ${RESULT_GROUP_LABELS[suggested]}`);
    }
  }

  // 2. Decision maker reached.
  if (analysis.decisionMaker.reached === 'yes' && lead.decisionmaker !== true) addLeadOp('decisionmaker', true, 'Entscheider im Gespräch');

  // 3. Explicit field proposals (whitelisted in schemas.ts).
  for (const f of analysis.suggestion.fields) addLeadOp(f.field, f.value, f.reason.slice(0, 80) || 'KI-Vorschlag');

  // 4. New contact person (forwarded) → new lead of the same company (INTENT 6.8), only with a name.
  const leadCreates: LeadCreateOp[] = [];
  const fwd = analysis.decisionMaker.forwardedTo;
  if (analysis.decisionMaker.reached === 'forwarded' && fwd?.name) {
    const parts = fwd.name.trim().split(/\s+/);
    const lastname = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
    const firstname = parts.length > 1 ? parts[0] : null;
    leadCreates.push({
      id: 'ai-new-contact',
      fromLeadId: lead.leadid,
      fields: {
        companyname: lead.companyname,
        firstname,
        lastname,
        jobtitle: fwd.jobtitle ?? null,
        emailaddress1: cleanEmail(fwd.email),
        websiteurl: lead.websiteurl,
      },
    });
  }

  return { operations: [...ops.values()], leadCreates, baseSnapshot: snapshot };
}

// ---------------------------------------------------------------------------------------------------------------------
// Job: analyze call
// ---------------------------------------------------------------------------------------------------------------------

async function setAnalysis(deps: AiDeps, id: string, set: Partial<AnalysisRow>): Promise<void> {
  await deps.db.update(analyses).set({ ...set, updatedAt: deps.now() }).where(eq(analyses.id, id));
}

/** Job `ai.analyze_call`. On the last attempt an upstream failure marks the analysis `failed` (visible, dismissable). */
export async function analyzeCallJob(deps: AiDeps, analysisId: string, lastAttempt: boolean): Promise<'ready' | 'failed' | 'noop'> {
  const [a] = await deps.db.select().from(analyses).where(eq(analyses.id, analysisId));
  if (!a || a.kind !== 'call' || a.status !== 'running' || !a.callSessionId) return 'noop';
  const [call] = await deps.db.select().from(callSessions).where(eq(callSessions.id, a.callSessionId));
  if (!call) {
    await setAnalysis(deps, analysisId, { status: 'skipped', error: 'Anruf nicht gefunden' });
    return 'noop';
  }
  // A retry after a failed draft step reuses the stored (already paid) result instead of asking the AI again.
  const stored = (a.result as CallAnalysis | null) ?? null;
  if (!stored) {
    const budget = await budgetStatus(deps.db, deps.now());
    if (budget.exceeded) {
      await setAnalysis(deps, analysisId, { status: 'failed', error: budgetExceededError().message });
      return 'failed';
    }
  }
  try {
    let result: CallAnalysis;
    let lead: Lead;
    let model = a.model;
    if (stored) {
      const found = await deps.adapters.crm.getLead(a.leadId);
      if (!found) throw notFound('Lead nicht gefunden');
      result = stored;
      lead = found;
    } else {
      const transcript = await loadTranscript(deps, a.transcriptId);
      const ctx = await loadAiContext(deps, a.leadId, { note: call.noteDraft, transcript });
      const out = await deps.adapters.ai.analyzeCall(ctx);
      // Keep the result right away (status stays `running`) so a failing draft step does not lose it.
      await setAnalysis(deps, analysisId, { result: out.result, model: out.model, usage: out.usage, error: null });
      result = out.result;
      lead = ctx.lead;
      model = out.model;
    }
    const draft = await draftChangeSetValues(deps, call, result, lead);
    // Draft change set and status `ready` in one transaction: an analysis is never `ready` without its draft.
    const marked = await deps.db
      .transaction(async (tx) => {
        const [cs] = await tx.insert(changeSets).values(draft).returning({ id: changeSets.id });
        const rows = await tx
          .update(analyses)
          .set({ status: 'ready', changeSetId: cs.id, error: null, updatedAt: deps.now() })
          .where(and(eq(analyses.id, analysisId), eq(analyses.status, 'running')))
          .returning({ id: analyses.id });
        // Finished or dismissed meanwhile → roll the draft back.
        if (!rows.length) throw new StaleAnalysis();
        return true;
      })
      .catch((err: unknown) => {
        if (err instanceof StaleAnalysis) return false;
        throw err;
      });
    if (!marked) return 'noop';
    deps.log.info({ analysisId, model }, 'call analysis ready');
    return 'ready';
  } catch (err) {
    if (!lastAttempt) throw err;
    const message = err instanceof AppError ? err.message : 'Analyse fehlgeschlagen';
    await setAnalysis(deps, analysisId, { status: 'failed', error: message });
    return 'failed';
  }
}

class StaleAnalysis extends Error {}

/** Insert values of the draft change set (kind `analysis`) for an analysis result. */
async function draftChangeSetValues(deps: AiDeps, call: CallRow, result: CallAnalysis, lead: Lead): Promise<typeof changeSets.$inferInsert> {
  const rules = await activeRuleDefinitions(deps.db);
  const proposals = buildProposals({
    analysis: result,
    lead,
    call: { resultGroup: call.resultGroup, crmPhonecallId: call.crmPhonecallId },
    rules,
    now: deps.now(),
  });
  const activity: ActivityOp = {
    id: 'ai-phonecall',
    action: 'update',
    type: 'phonecall',
    activityId: call.crmPhonecallId,
    leadId: lead.leadid,
    subject: `Anruf ${lead.companyname}${call.resultGroup ? ` – ${RESULT_GROUP_LABELS[call.resultGroup as keyof typeof RESULT_GROUP_LABELS] ?? ''}` : ''}`,
    text: composeCallText(call.noteDraft, result),
    direction: 'outgoing',
    interest: result.interest.level,
  };
  return {
    leadId: lead.leadid,
    // No callSessionId: the changesets push would otherwise treat this as the call's own result (see push.ts).
    callSessionId: null,
    kind: 'analysis',
    status: 'draft',
    operations: proposals.operations,
    activities: [activity],
    leadCreates: proposals.leadCreates,
    baseSnapshot: proposals.baseSnapshot,
    createdBy: call.userId,
  };
}

/**
 * Repair for analyses that are `ready` but lack their draft (written before the draft step became transactional):
 * rebuild the draft from the stored result instead of leaving the paid analysis un-approvable.
 */
async function ensureDraft(deps: AiDeps, a: AnalysisRow, call: CallRow): Promise<string> {
  if (a.changeSetId) return a.changeSetId;
  const lead = await deps.adapters.crm.getLead(a.leadId);
  if (!lead) throw notFound('Lead nicht gefunden');
  const draft = await draftChangeSetValues(deps, call, a.result as CallAnalysis, lead);
  return deps.db.transaction(async (tx) => {
    const [cs] = await tx.insert(changeSets).values(draft).returning({ id: changeSets.id });
    const rows = await tx
      .update(analyses)
      .set({ changeSetId: cs.id, updatedAt: deps.now() })
      .where(and(eq(analyses.id, a.id), eq(analyses.status, 'ready'), isNull(analyses.changeSetId)))
      .returning({ id: analyses.id });
    if (!rows.length) throw conflict('Die Analyse wurde gerade geändert – bitte neu laden', 'analysis_changed');
    return cs.id;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Review list, approve, dismiss
// ---------------------------------------------------------------------------------------------------------------------

export interface AnalysisReviewItem {
  analysis: Analysis;
  call: {
    id: string;
    leadName: string | null;
    companyName: string | null;
    endedAt: string | null;
    durationSec: number | null;
    resultGroup: string | null;
    resultLabel: string | null;
    /** The call result is in the CRM (phone call exists) → «Ergänzen» possible. */
    pushed: boolean;
  } | null;
  changeSet: ChangeSet | null;
  /** Future bookings of the lead (preparation proposal can be applied to them). */
  upcomingBookingIds: string[];
}

export async function listReviewItems(deps: AiDeps, ownerUserId: string): Promise<AnalysisReviewItem[]> {
  const rows = await deps.db
    .select()
    .from(analyses)
    .where(and(eq(analyses.kind, 'call'), eq(analyses.ownerUserId, ownerUserId), inArray(analyses.status, ['ready', 'failed'])))
    .orderBy(desc(analyses.createdAt))
    .limit(100);
  return Promise.all(rows.map((r) => reviewItem(deps, r)));
}

async function reviewItem(deps: AiDeps, r: AnalysisRow): Promise<AnalysisReviewItem> {
  const [call] = r.callSessionId ? await deps.db.select().from(callSessions).where(eq(callSessions.id, r.callSessionId)) : [];
  const [cs] = r.changeSetId ? await deps.db.select().from(changeSets).where(eq(changeSets.id, r.changeSetId)) : [];
  const upcoming = await deps.db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.leadId, r.leadId), gt(bookings.startAt, deps.now()), inArray(bookings.status, ['booked', 'rescheduled'])));
  return {
    analysis: toAnalysis(r),
    call: call
      ? {
          id: call.id,
          leadName: call.leadName,
          companyName: call.companyName,
          endedAt: call.endedAt?.toISOString() ?? null,
          durationSec: call.durationSec,
          resultGroup: call.resultGroup,
          resultLabel: call.resultGroup ? (RESULT_GROUP_LABELS[call.resultGroup as keyof typeof RESULT_GROUP_LABELS] ?? null) : null,
          pushed: !!call.crmPhonecallId,
        }
      : null,
    changeSet: cs ? rowToChangeSet(cs) : null,
    upcomingBookingIds: upcoming.map((b) => b.id),
  };
}

export async function getReviewItem(deps: AiDeps, auth: RequestAuth, analysisId: string): Promise<AnalysisReviewItem> {
  const r = await loadCallAnalysis(deps, auth, analysisId);
  return reviewItem(deps, r);
}

async function loadCallAnalysis(deps: AiDeps, auth: RequestAuth, analysisId: string): Promise<AnalysisRow> {
  const [r] = await deps.db.select().from(analyses).where(eq(analyses.id, analysisId));
  if (!r || r.kind !== 'call') throw notFound('Analyse nicht gefunden');
  assertOwnerOrAdmin(auth, r.ownerUserId);
  return r;
}

export interface ApproveInput {
  /** Proposal op ids Markus ticked (field ops). The phone-call summary is always part of «Ergänzen». */
  acceptOpIds: string[];
  acceptLeadCreate: boolean;
  resolutions?: Record<string, 'overwrite' | 'keep_crm'>;
  /** Apply «Vorbereitung nötig» to the lead's upcoming bookings (INTENT 6.10: the analysis may propose it). */
  applyPreparation?: boolean;
}

export type ApproveResult =
  | { status: 'approved'; analysis: Analysis; changeSet: ChangeSet }
  | { status: 'conflict'; conflicts: Conflict[]; changeSet: ChangeSet };

export async function approveAnalysis(deps: AiDeps, auth: RequestAuth, analysisId: string, input: ApproveInput): Promise<ApproveResult> {
  const a = await loadCallAnalysis(deps, auth, analysisId);
  if (a.status !== 'ready') throw conflict('Diese Analyse ist bereits erledigt', 'analysis_done');
  if (!a.callSessionId || !a.result) throw conflict('Analyse ist unvollständig', 'analysis_incomplete');
  const [call] = await deps.db.select().from(callSessions).where(eq(callSessions.id, a.callSessionId));
  if (!call) throw conflict('Analyse ist unvollständig', 'analysis_incomplete');
  if (!call.crmPhonecallId) {
    throw conflict('Zuerst das Ergebnis des Anrufs freigeben – dann kann die Analyse ergänzt werden', 'call_not_pushed');
  }
  const changeSetId = await ensureDraft(deps, a, call);
  const [draft] = await deps.db.select().from(changeSets).where(eq(changeSets.id, changeSetId));
  if (!draft) throw notFound('Entwurf nicht gefunden');
  if (draft.status === 'pushed') throw conflict('Diese Analyse ist bereits ergänzt', 'analysis_done');

  // Current phone-call text: keep what is in the CRM and append the summary (never overwrite the note).
  const current = await deps.adapters.crm.getFieldValues('phonecall', call.crmPhonecallId, ['description']);
  const result = a.result as CallAnalysis;
  const accepted = new Set(input.acceptOpIds);
  const activities: ActivityOp[] = draft.activities.map((act) =>
    act.type === 'phonecall'
      ? { ...act, activityId: call.crmPhonecallId, text: composeCallText((current.description as string | null) ?? call.noteDraft, result), interest: result.interest.level }
      : act,
  );
  const operations = draft.operations
    .filter((op) => accepted.has(op.id))
    .map((op) => (op.entity === 'phonecall' ? { ...op, entityId: call.crmPhonecallId! } : op));
  const leadCreates = input.acceptLeadCreate ? draft.leadCreates : [];
  const baseSnapshot = Object.fromEntries(
    Object.entries(draft.baseSnapshot).map(([k, v]) => [k.startsWith('phonecall:') ? snapshotKeyOf('phonecall', call.crmPhonecallId!, k.split(':').pop()!) : k, v]),
  );

  const [prepared] = await deps.db
    .update(changeSets)
    .set({ operations, activities, leadCreates, baseSnapshot, updatedAt: deps.now() })
    .where(eq(changeSets.id, draft.id))
    .returning();

  const outcome = await pushChangeSet(deps, prepared as ChangeSetRow, auth, input.resolutions ?? {});
  if (outcome.status !== 'pushed') {
    // Restore the full proposal list so the UI can still show unticked proposals (nothing gets lost).
    await deps.db.update(changeSets).set({ operations: draft.operations, leadCreates: draft.leadCreates }).where(eq(changeSets.id, draft.id));
  }
  if (outcome.status === 'conflict') {
    return { status: 'conflict', conflicts: outcome.conflicts, changeSet: { ...outcome.changeSet, operations: draft.operations, leadCreates: draft.leadCreates } };
  }
  if (outcome.status === 'failed') throw new AppError(502, 'push_failed', `Ergänzen hat nicht geklappt: ${outcome.error}. Der Entwurf bleibt erhalten.`);

  const now = deps.now();
  await setAnalysis(deps, analysisId, { status: 'approved', reviewedBy: auth.user.id, reviewedAt: now });
  await audit(deps.db, {
    actor: auth.actor,
    action: 'ai.analysis_approve',
    entity: 'analysis',
    entityId: analysisId,
    changeSetId: draft.id,
    meta: { leadId: a.leadId, proposalsAccepted: operations.length, leadCreate: leadCreates.length > 0 },
  });

  // Briefings of upcoming bookings are rebuilt with the approved analysis (INTENT 6.4 / 6.10).
  const upcoming = await deps.db
    .select()
    .from(bookings)
    .where(and(eq(bookings.leadId, a.leadId), gt(bookings.startAt, now), inArray(bookings.status, ['booked', 'rescheduled'])));
  for (const b of upcoming) {
    if (input.applyPreparation && result.suggestion.preparationNeeded && !b.needsPreparation) {
      await deps.db.update(bookings).set({ needsPreparation: true, updatedAt: now }).where(eq(bookings.id, b.id));
      await audit(deps.db, { actor: auth.actor, action: 'ai.booking_preparation', entity: 'booking', entityId: b.id, field: 'needsPreparation', oldValue: false, newValue: true });
    }
    await enqueueJob(deps.db, JOB_BUILD_BRIEFING, { bookingId: b.id }, { dedupeKey: `${JOB_BUILD_BRIEFING}:${b.id}`, maxAttempts: 3 });
  }

  const [fresh] = await deps.db.select().from(analyses).where(eq(analyses.id, analysisId));
  return { status: 'approved', analysis: toAnalysis(fresh), changeSet: outcome.changeSet };
}

export async function dismissAnalysis(deps: AiDeps, auth: RequestAuth, analysisId: string): Promise<Analysis> {
  const a = await loadCallAnalysis(deps, auth, analysisId);
  if (a.status !== 'ready' && a.status !== 'failed') throw conflict('Diese Analyse ist bereits erledigt', 'analysis_done');
  const now = deps.now();
  await setAnalysis(deps, analysisId, { status: 'rejected', reviewedBy: auth.user.id, reviewedAt: now });
  if (a.changeSetId) {
    await deps.db
      .update(changeSets)
      .set({ status: 'discarded', updatedAt: now })
      .where(and(eq(changeSets.id, a.changeSetId), inArray(changeSets.status, ['draft', 'conflict', 'failed'])));
  }
  await audit(deps.db, { actor: auth.actor, action: 'ai.analysis_dismiss', entity: 'analysis', entityId: analysisId, changeSetId: a.changeSetId });
  const [fresh] = await deps.db.select().from(analyses).where(eq(analyses.id, analysisId));
  return toAnalysis(fresh);
}

/** Header counter «Analysen zur Freigabe». */
export async function countReadyAnalyses(deps: Pick<AiDeps, 'db'>, ownerUserId: string): Promise<number> {
  const rows = await deps.db
    .select({ id: analyses.id })
    .from(analyses)
    .where(and(eq(analyses.kind, 'call'), eq(analyses.ownerUserId, ownerUserId), eq(analyses.status, 'ready')));
  return rows.length;
}
