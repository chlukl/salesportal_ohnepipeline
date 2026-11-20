/**
 * Change sets (INTENT 6.5, 6.9): result group → draft (preview alt → neu) → conflict check right before the push →
 * push in one pass via `crm.applyChangeSet` → audit every field with its old value. Failures stay as draft («failed»)
 * and can be retried (only the failed part is pushed again). Rule key + version are stored with every change set.
 *
 * OWNER: coldcall implementer.
 */
import {
  buildChangeSet,
  buildRevertDraft,
  detectConflicts,
  fieldsToReread,
  pendingPart,
  resolveConflicts,
  ResultInputError,
  snapshotKey,
  valuesEqual,
  type ChangeSet,
  type ChangeSetDraft,
  type ChangeSetStatus,
  type Conflict,
  type CrmTask,
  type OperationResult,
  type ResultGroupKey,
  type ResultInput,
  type ResultInputIssue,
} from '@sales-portal/shared';
import { and, desc, eq, inArray, isNull, or, sql, type InferSelectModel, type SQL } from 'drizzle-orm';
import type { RequestAuth } from '../../auth/rbac';
import type { Db } from '../../db/client';
import { bookings, callSessions, changeSets } from '../../db/schema';
import type { CrmAdapter, CrmEntity } from '../../integrations/crm';
import { auditMany, type AuditInput } from '../../lib/audit';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { getSetting } from '../../lib/settings';
import { getActiveRule } from './rules';

type Row = InferSelectModel<typeof changeSets>;
type CallRow = InferSelectModel<typeof callSessions>;

/** Key in baseSnapshot that keeps the wrap-up input (so a reload can restore the form). Not a CRM field. */
export const INPUT_META_KEY = 'meta:input';
/** «Rückgängig» for the caller is possible for this long after the push; admins can reset any time. */
export const UNDO_WINDOW_MINUTES = 15;

export interface ChangeSetCtx {
  db: Db;
  crm: CrmAdapter;
  auth: RequestAuth;
  now: () => Date;
}

export function toChangeSet(r: Row): ChangeSet {
  return {
    id: r.id,
    leadId: r.leadId,
    callSessionId: r.callSessionId,
    kind: r.kind as ChangeSet['kind'],
    ruleKey: (r.ruleKey as ChangeSet['ruleKey']) ?? null,
    ruleVersion: r.ruleVersion,
    operations: r.operations,
    activities: r.activities,
    tasks: r.tasks,
    notes: r.notes,
    stateChanges: r.stateChanges,
    leadCreates: r.leadCreates,
    baseSnapshot: r.baseSnapshot,
    status: r.status,
    conflicts: r.conflicts,
    results: r.results,
    error: r.error,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    pushedAt: r.pushedAt ? r.pushedAt.toISOString() : null,
    pushedBy: r.pushedBy,
  };
}

export const isAdmin = (auth: RequestAuth) => auth.effectiveRoles.includes('admin');

/** How a change-set function is reached: through the generic /api/changesets routes, or from another module. */
export interface AccessOptions {
  /**
   * `true` for the generic /api/changesets routes. Kinds with their own approval flow (AI analyses: per-proposal
   * ticks, call result first, phone-call text re-read – modules/ai) cannot be pushed, rebuilt or discarded there.
   */
  external?: boolean;
}

/** Change-set kinds that only their own module may push / discard (never the generic «Freigeben»). */
export const OWN_FLOW_KINDS: ReadonlySet<string> = new Set(['analysis']);

export function assertGenericAccess(row: Pick<Row, 'kind'>, options: AccessOptions): void {
  if (options.external && OWN_FLOW_KINDS.has(row.kind)) {
    throw conflict('KI-Analysen werden unter «Analysen zur Freigabe» geprüft – dort nur die angekreuzten Vorschläge freigeben', 'analysis_own_flow');
  }
}

/** A push still running (or interrupted) is never claimed twice; after this long it may be discarded. */
export const PENDING_STALE_MINUTES = 10;
const OPEN_STATUSES = ['draft', 'conflict', 'failed'] as const;

export async function listOwnChangeSets(db: Db, userId: string, status?: ChangeSetStatus): Promise<ChangeSet[]> {
  const rows = await db
    .select()
    .from(changeSets)
    .where(status ? and(eq(changeSets.createdBy, userId), eq(changeSets.status, status)) : eq(changeSets.createdBy, userId))
    .orderBy(desc(changeSets.createdAt))
    .limit(200);
  return rows.map(toChangeSet);
}

/** List for the Freigaben/Fehler in the Pendenzen. Only admins may see other people's change sets. */
export async function listChangeSets(
  ctx: Pick<ChangeSetCtx, 'db' | 'auth'>,
  q: { status?: ChangeSetStatus[]; userId?: string; all?: boolean; leadId?: string; limit?: number },
): Promise<ChangeSet[]> {
  const conditions: SQL[] = [];
  if (q.all || (q.userId && q.userId !== ctx.auth.user.id)) {
    if (!isAdmin(ctx.auth)) throw forbidden('Nur Admins sehen Entwürfe anderer Personen');
    if (q.userId) conditions.push(eq(changeSets.createdBy, q.userId));
  } else {
    conditions.push(eq(changeSets.createdBy, ctx.auth.user.id));
  }
  if (q.status?.length) conditions.push(inArray(changeSets.status, q.status));
  if (q.leadId) conditions.push(eq(changeSets.leadId, q.leadId));
  const rows = await ctx.db
    .select()
    .from(changeSets)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(changeSets.createdAt))
    .limit(Math.min(q.limit ?? 200, 500));
  return rows.map(toChangeSet);
}

/** Load a change set the current user may act on (own, or any for admins). Not-owned → 404 (no existence leak). */
export async function loadOwnedRow(ctx: Pick<ChangeSetCtx, 'db' | 'auth'>, id: string): Promise<Row> {
  const [row] = await ctx.db.select().from(changeSets).where(eq(changeSets.id, id));
  if (!row || (row.createdBy !== ctx.auth.user.id && !isAdmin(ctx.auth))) throw notFound('Entwurf nicht gefunden');
  return row;
}

export async function loadOwnedCall(ctx: Pick<ChangeSetCtx, 'db' | 'auth'>, id: string): Promise<CallRow> {
  const [row] = await ctx.db.select().from(callSessions).where(eq(callSessions.id, id));
  if (!row || (row.userId !== ctx.auth.user.id && !isAdmin(ctx.auth))) throw notFound('Anruf nicht gefunden');
  return row;
}

// ---------------------------------------------------------------------------------------------------------------------
// Draft (preview)
// ---------------------------------------------------------------------------------------------------------------------

export interface DraftRequest {
  leadId: string;
  callSessionId?: string | null;
  ruleKey: ResultGroupKey;
  input: ResultInput;
  /** Rebuild this draft instead of creating a new one. */
  changeSetId?: string | null;
}

export interface DraftResponse {
  changeSet: ChangeSet | null;
  issues: ResultInputIssue[];
}

/** Everything the engine needs about the company's tasks and leads. */
async function taskContext(crm: CrmAdapter, leadId: string, ownerCrmId: string | null) {
  const persons = await crm.getCompanyPersons(leadId);
  const companyLeadIds = [...new Set([leadId, ...persons.filter((p) => p.source === 'lead').map((p) => p.id)])];
  const [companyTasks, ownerOpenTasks] = await Promise.all([
    Promise.all(companyLeadIds.map((id) => crm.listTasks({ leadId: id, status: 'open' }))).then((lists) => lists.flat()),
    ownerCrmId ? crm.listTasks({ ownerId: ownerCrmId, status: 'open' }) : Promise.resolve([] as CrmTask[]),
  ]);
  const companyOpenLeadCount = persons.filter((p) => p.source === 'lead' && p.statecode === 0).length;
  return { openCompanyTasks: companyTasks, ownerOpenTasks, companyOpenLeadCount: Math.max(companyOpenLeadCount, 1) };
}

/** Build (or rebuild) the draft for a wrap-up. Input problems come back as `issues` (shown next to the fields). */
export async function upsertDraft(ctx: ChangeSetCtx, req: DraftRequest, options: AccessOptions = {}): Promise<DraftResponse> {
  const rule = await getActiveRule(ctx.db, req.ruleKey);
  if (!rule) throw badRequest('Ergebnisgruppe ist nicht aktiv');
  const lead = await ctx.crm.getLead(req.leadId);
  if (!lead) throw notFound('Lead nicht gefunden');

  let call: CallRow | null = null;
  if (req.callSessionId) {
    call = await loadOwnedCall(ctx, req.callSessionId);
    // Results are recorded by the person who called (admins may view and retry, not act as the caller).
    if (call.userId !== ctx.auth.user.id) throw forbidden('Das Ergebnis erfasst die Person, die angerufen hat');
    if (call.leadId !== req.leadId) throw badRequest('Anruf gehört zu einem anderen Lead');
    if (call.status === 'completed' || call.status === 'abandoned') throw conflict('Dieser Anruf ist schon abgeschlossen');
  }

  // Which row to rebuild: the given one, or the open draft of this call.
  let existing: Row | null = null;
  if (req.changeSetId) {
    existing = await loadOwnedRow(ctx, req.changeSetId);
    assertGenericAccess(existing, options);
    // Only a call's own result draft is rebuilt here (booking / mail / manual drafts keep their content).
    if (existing.kind !== 'call_result' && existing.kind !== 'not_reached') throw conflict('Dieser Entwurf kann hier nicht geändert werden', 'changeset_kind');
  } else if (call) {
    [existing] = await ctx.db
      .select()
      .from(changeSets)
      .where(and(eq(changeSets.callSessionId, call.id), inArray(changeSets.status, ['draft', 'conflict', 'failed']), inArray(changeSets.kind, ['call_result', 'not_reached'])))
      .orderBy(desc(changeSets.createdAt))
      .limit(1);
    existing ??= null;
  }
  if (call) {
    // The result of this call is being written right now (double click, second tab) → no second draft.
    const [running] = await ctx.db
      .select({ id: changeSets.id })
      .from(changeSets)
      .where(and(eq(changeSets.callSessionId, call.id), eq(changeSets.status, 'pending'), inArray(changeSets.kind, ['call_result', 'not_reached'])))
      .limit(1);
    if (running) throw conflict('Das Ergebnis dieses Anrufs wird gerade gespeichert', 'push_running');
  }
  if (existing) {
    if (existing.status === 'pending') throw conflict('Diese Änderungen werden gerade gespeichert', 'push_running');
    if (!['draft', 'conflict', 'failed'].includes(existing.status)) throw conflict('Diese Änderungen sind schon gespeichert');
    if (existing.leadId !== req.leadId) throw badRequest('Entwurf gehört zu einem anderen Lead');
    if (existing.results.some((r) => r.ok)) throw conflict('Teil der Änderungen ist schon im CRM – bitte zuerst «Erneut versuchen»');
  }

  if (rule.followUp.type === 'booking' && !(await hasActiveBooking(ctx.db, lead.leadid, call?.id ?? null))) {
    return { changeSet: existing ? toChangeSet(existing) : null, issues: [BOOKING_MISSING_ISSUE] };
  }

  const actor = ctx.auth.actor;
  const tc = await taskContext(ctx.crm, lead.leadid, actor.crmUserId);
  const maxPerDay = await getSetting(ctx.db, 'tasks.maxPerPersonPerDay');
  let draft: ChangeSetDraft;
  try {
    draft = buildChangeSet({
      rule,
      lead,
      input: req.input,
      actor,
      callSession: call ? callForEngine(call, ctx.now()) : null,
      openCompanyTasks: tc.openCompanyTasks,
      ownerOpenTasks: tc.ownerOpenTasks,
      companyOpenLeadCount: tc.companyOpenLeadCount,
      maxTasksPerPersonPerDay: maxPerDay,
      now: ctx.now(),
    });
  } catch (err) {
    if (err instanceof ResultInputError) return { changeSet: existing ? toChangeSet(existing) : null, issues: err.issues };
    throw err;
  }
  const values = {
    ...draft,
    callSessionId: call?.id ?? null,
    baseSnapshot: { ...draft.baseSnapshot, [INPUT_META_KEY]: req.input },
    status: 'draft' as const,
    conflicts: [] as Conflict[],
    results: [] as OperationResult[],
    error: null,
    updatedAt: ctx.now(),
  };
  const [row] = existing
    ? await ctx.db
        .update(changeSets)
        .set(values)
        // Never turn a row back into a draft while it is being pushed.
        .where(and(eq(changeSets.id, existing.id), inArray(changeSets.status, [...OPEN_STATUSES])))
        .returning()
    : await ctx.db.insert(changeSets).values({ ...values, createdBy: ctx.auth.user.id, createdAt: ctx.now() }).returning();
  if (!row) throw conflict('Diese Änderungen werden gerade gespeichert', 'push_running');
  return { changeSet: toChangeSet(row), issues: [] };
}

/** «Termin gebucht» comes with the booking (INTENT 5, 6.5): without an active booking there is nothing to approve. */
export const BOOKING_MISSING_ISSUE: ResultInputIssue = {
  field: 'booking',
  message: 'Zuerst im Terminplaner buchen – «Termin gebucht» kommt mit der Buchung',
};

/** Active booking (booked / rescheduled) of this call or of the lead. */
export async function hasActiveBooking(db: Db, leadId: string, callSessionId: string | null): Promise<boolean> {
  const [row] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        inArray(bookings.status, ['booked', 'rescheduled']),
        callSessionId ? or(eq(bookings.leadId, leadId), eq(bookings.callSessionId, callSessionId)) : eq(bookings.leadId, leadId),
      ),
    )
    .limit(1);
  return !!row;
}

/** Call-session fields the engine needs; duration from the clicks if Vera has not delivered yet. */
export function callForEngine(call: CallRow, now: Date) {
  const endedAt = call.endedAt ?? (call.connectedAt ? now : null);
  return {
    id: call.id,
    dialedAt: call.dialedAt?.toISOString() ?? null,
    connectedAt: call.connectedAt?.toISOString() ?? null,
    endedAt: endedAt?.toISOString() ?? null,
    durationSec: call.durationSec,
    noteDraft: call.noteDraft,
    phoneE164: call.phoneE164,
    phoneDisplay: call.phoneDisplay,
    direction: call.direction,
  };
}

export async function endCallRow(db: Db, call: CallRow, now: Date): Promise<void> {
  if (call.status !== 'dialing' && call.status !== 'connected') return;
  const durationSec = call.connectedAt ? Math.max(0, Math.round((now.getTime() - call.connectedAt.getTime()) / 1000)) : null;
  await db
    .update(callSessions)
    .set({ status: 'ended', endedAt: now, durationSec: call.durationSec ?? durationSec, durationSource: call.durationSource ?? 'clicks', updatedAt: now })
    .where(eq(callSessions.id, call.id));
}

// ---------------------------------------------------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------------------------------------------------

export interface PushResponse {
  status: ChangeSetStatus;
  changeSet: ChangeSet;
}

/** Current CRM values of every field the change set touches (for the conflict check and the audit). */
export async function rereadCrm(crm: CrmAdapter, cs: Pick<ChangeSet, 'operations' | 'stateChanges'>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const target of fieldsToReread(cs)) {
    const values = await crm.getFieldValues(target.entity as CrmEntity, target.id, target.fields);
    for (const f of target.fields) if (f in values) out[snapshotKey(target.entity, target.id, f)] = values[f];
  }
  return out;
}

/**
 * Re-read, check conflicts, push. With unresolved conflicts the change set goes to status «conflict» and nothing is
 * written; the caller decides per field (`overwrite` / `keep_crm`) and pushes again.
 */
export async function pushChangeSet(
  ctx: ChangeSetCtx,
  id: string,
  resolutions: Record<string, 'overwrite' | 'keep_crm'> = {},
  options: AccessOptions = {},
): Promise<PushResponse> {
  const row = await loadOwnedRow(ctx, id);
  assertGenericAccess(row, options);
  if (row.status === 'pushed') throw conflict('Diese Änderungen sind schon gespeichert');
  if (row.status === 'discarded') throw conflict('Dieser Entwurf wurde verworfen');
  if (row.status === 'pending' && !isFreshPending(row)) throw conflict('Diese Änderungen werden gerade gespeichert', 'push_running');
  if (row.kind === 'call_result' && row.ruleKey) {
    const rule = await getActiveRule(ctx.db, row.ruleKey as ResultGroupKey);
    if (rule?.followUp.type === 'booking' && !(await hasActiveBooking(ctx.db, row.leadId, row.callSessionId))) {
      throw new AppError(409, 'booking_missing', BOOKING_MISSING_ISSUE.message);
    }
  }
  const cs = toChangeSet(row);

  // The note may have changed after the preview: the phone call always carries the latest note of the call.
  // Booking / mail change sets of a running call (approved mid-call) must not end the conversation.
  if (cs.callSessionId && (row.kind === 'call_result' || row.kind === 'not_reached')) {
    let [call] = await ctx.db.select().from(callSessions).where(eq(callSessions.id, cs.callSessionId));
    if (call && call.status === 'connected' && row.kind === 'call_result') {
      // Approving a result ends the conversation («Aufgelegt» was skipped) – duration from the clicks.
      await endCallRow(ctx.db, call, ctx.now());
      [call] = await ctx.db.select().from(callSessions).where(eq(callSessions.id, cs.callSessionId));
    }
    if (call) {
      const fresh = callForEngine(call, ctx.now());
      cs.activities = cs.activities.map((a) =>
        a.type === 'phonecall' && a.action === 'create'
          ? {
              ...a,
              text: call.noteDraft?.trim() || null,
              end: fresh.endedAt ?? a.end,
              durationSec: call.connectedAt ? (call.durationSec ?? a.durationSec) : a.durationSec,
            }
          : a,
      );
    }
  }

  const part = pendingPart(cs, cs.results);
  const crmNow = await rereadCrm(ctx.crm, part);
  const detected = detectConflicts(part, crmNow);
  const previous = Object.fromEntries(cs.conflicts.filter((c) => c.resolution).map((c) => [c.opId, c.resolution!]));
  const resolved = resolveConflicts(part, detected, { ...previous, ...resolutions });
  if (!resolved.ok) {
    const [updated] = await ctx.db
      .update(changeSets)
      .set({ status: 'conflict', conflicts: resolved.conflicts, activities: cs.activities, updatedAt: ctx.now() })
      .where(and(eq(changeSets.id, row.id), claimableWhere()))
      .returning();
    if (!updated) throw conflict('Diese Änderungen werden gerade gespeichert', 'push_running');
    return { status: 'conflict', changeSet: toChangeSet(updated) };
  }
  // The adapter needs the decisions («Überschreiben» / «CRM-Wert behalten») in the pushed object itself: the live
  // adapter re-checks every field against the draft snapshot and only skips that check for resolved conflicts.
  return executePush(ctx, row, dropNoOps({ ...cs, ...resolved.changeSet, conflicts: resolved.conflicts }, crmNow), crmNow, resolved.conflicts);
}

/**
 * A row in status «pending» that nobody has claimed yet (inserted as pending by another module, e.g. the sent
 * use-case mail). A claimed row carries `pushedBy` (the person pushing) until the push has finished.
 */
function isFreshPending(row: Pick<Row, 'status' | 'pushedBy' | 'results'>): boolean {
  return row.status === 'pending' && row.pushedBy == null && row.results.length === 0;
}

/** SQL: rows a push may claim (open drafts, or unclaimed fresh «pending» rows). */
function claimableWhere(): SQL {
  return or(
    inArray(changeSets.status, [...OPEN_STATUSES]),
    and(eq(changeSets.status, 'pending'), isNull(changeSets.pushedBy), sql`jsonb_array_length(${changeSets.results}) = 0`),
  )!;
}

/**
 * Field operations whose value is already in the CRM are not written again. This is what keeps «Termin gebucht» from
 * pushing the same fields twice: the booking change set (scheduling) and the call's result change set (calls) both
 * carry the meeting_booked fields – whichever is approved second only adds its activity.
 */
export function dropNoOps<T extends Pick<ChangeSet, 'operations'>>(cs: T, crmNow: Record<string, unknown>): T {
  const operations = cs.operations.filter((op) => {
    const key = snapshotKey(op.entity, op.entityId, op.field);
    if (!(key in crmNow)) return true;
    const now = crmNow[key];
    if (op.mode === 'add_to_multiselect') {
      const have = Array.isArray(now) ? now : [];
      const want = Array.isArray(op.newValue) ? op.newValue : [op.newValue];
      return !want.every((v) => have.some((h) => valuesEqual(h, v)));
    }
    return !valuesEqual(now, op.newValue);
  });
  return operations.length === cs.operations.length ? cs : { ...cs, operations };
}

async function executePush(
  ctx: ChangeSetCtx,
  row: Row,
  toPush: ChangeSet,
  crmNow: Record<string, unknown>,
  conflicts: Conflict[],
  auditMeta: Record<string, unknown> = {},
): Promise<PushResponse> {
  // Claim the row atomically: a second click / tab / key repeat gets 409 instead of writing everything twice.
  const [claimed] = await ctx.db
    .update(changeSets)
    .set({ status: 'pending', pushedBy: ctx.auth.user.id, updatedAt: ctx.now() })
    .where(and(eq(changeSets.id, row.id), claimableWhere()))
    .returning({ id: changeSets.id });
  if (!claimed) throw conflict('Diese Änderungen werden gerade gespeichert', 'push_running');
  let results: OperationResult[];
  let phonecallId: string | null = null;
  try {
    const applied = await ctx.crm.applyChangeSet(toPush, ctx.auth.actor);
    results = applied.results;
    phonecallId = applied.phonecallId ?? null;
  } catch (err) {
    // Adapter-level failure (connection, token): nothing is lost, the draft stays for a retry.
    results = [];
    const message = err instanceof Error && 'statusCode' in err ? err.message : 'CRM nicht erreichbar';
    const [failed] = await ctx.db
      .update(changeSets)
      .set({ status: 'failed', error: `${message} – Entwurf bleibt gespeichert, bitte erneut versuchen`, conflicts, activities: toPush.activities, pushedBy: null, updatedAt: ctx.now() })
      .where(eq(changeSets.id, row.id))
      .returning();
    await auditMany(ctx.db, [pushAudit(ctx, row, 'changeset.push_failed', { error: message, ...auditMeta })]);
    return { status: 'failed', changeSet: toChangeSet(failed) };
  }

  const merged = [...row.results.filter((r) => r.ok), ...results];
  const failedCount = results.filter((r) => !r.ok).length;
  const status: ChangeSetStatus = failedCount === 0 ? 'pushed' : 'failed';
  const now = ctx.now();

  await auditMany(ctx.db, [...auditEntries(ctx, row.id, toPush, results, crmNow), pushAudit(ctx, row, status === 'pushed' ? 'changeset.push' : 'changeset.push_failed', { failed: failedCount, ...auditMeta })]);

  const [updated] = await ctx.db
    .update(changeSets)
    .set({
      status,
      results: merged,
      conflicts,
      activities: toPush.activities.length ? mergeActivities(row.activities, toPush.activities) : row.activities,
      error: failedCount ? `${failedCount} von ${results.length} Änderungen fehlgeschlagen – bitte erneut versuchen` : null,
      updatedAt: now,
      pushedAt: status === 'pushed' ? now : null,
      pushedBy: status === 'pushed' ? ctx.auth.user.id : null,
    })
    .where(eq(changeSets.id, row.id))
    .returning();

  // Only the call's own result change set finishes the call. Booking / proposals-mail change sets carry the
  // callSessionId for reference (scheduling), but the phone call activity still comes with the call result.
  if (row.callSessionId && (row.kind === 'call_result' || row.kind === 'not_reached')) {
    const phonecall = phonecallId ?? merged.find((r) => r.kind === 'activity' && r.ok && r.createdId)?.createdId ?? null;
    const isNotReached = row.kind === 'not_reached';
    await ctx.db
      .update(callSessions)
      .set({
        status: status === 'pushed' ? (isNotReached ? 'not_reached' : 'completed') : 'ended',
        resultGroup: row.ruleKey,
        changeSetId: row.id,
        ...(phonecall ? { crmPhonecallId: phonecall } : {}),
        updatedAt: now,
      })
      .where(and(eq(callSessions.id, row.callSessionId), inArray(callSessions.status, ['dialing', 'connected', 'ended', 'not_reached'])));
  }
  return { status, changeSet: toChangeSet(updated) };
}

function mergeActivities(stored: ChangeSet['activities'], pushed: ChangeSet['activities']): ChangeSet['activities'] {
  const byId = new Map(pushed.map((a) => [a.id, a]));
  return stored.map((a) => byId.get(a.id) ?? a);
}

function pushAudit(ctx: ChangeSetCtx, row: Row, action: string, meta: Record<string, unknown>): AuditInput {
  return {
    actor: ctx.auth.actor,
    action,
    entity: 'change_set',
    entityId: row.id,
    changeSetId: row.id,
    meta: { leadId: row.leadId, ruleKey: row.ruleKey, ruleVersion: row.ruleVersion, kind: row.kind, ...meta },
  };
}

/** One audit entry per successful operation; fields with the CRM value that was overwritten. */
function auditEntries(ctx: ChangeSetCtx, changeSetId: string, cs: ChangeSet, results: OperationResult[], crmNow: Record<string, unknown>): AuditInput[] {
  const ok = new Map(results.filter((r) => r.ok).map((r) => [r.opId, r]));
  const out: AuditInput[] = [];
  const actor = ctx.auth.actor;
  for (const op of cs.operations) {
    if (!ok.has(op.id)) continue;
    const key = snapshotKey(op.entity, op.entityId, op.field);
    out.push({ actor, action: 'crm.field_update', entity: op.entity, entityId: op.entityId, field: op.field, oldValue: key in crmNow ? crmNow[key] : op.oldValue, newValue: op.newValue, changeSetId, meta: { mode: op.mode, label: op.label } });
  }
  for (const a of cs.activities) {
    const r = ok.get(a.id);
    if (!r) continue;
    out.push({ actor, action: a.action === 'create' ? 'crm.activity_create' : 'crm.activity_update', entity: a.type, entityId: r.createdId ?? a.activityId ?? null, changeSetId, newValue: { subject: a.subject, resultCode: a.resultCode ?? null, statecode: a.statecode ?? null }, meta: { leadId: a.leadId } });
  }
  for (const n of cs.notes) {
    const r = ok.get(n.id);
    if (r) out.push({ actor, action: 'crm.note_create', entity: 'note', entityId: r.createdId ?? null, changeSetId, meta: { leadId: n.leadId } });
  }
  for (const t of cs.tasks) {
    const r = ok.get(t.id);
    if (r) out.push({ actor, action: `crm.task_${t.action}`, entity: 'task', entityId: r.createdId ?? t.taskId ?? null, field: t.action === 'update' ? 'scheduledend' : null, newValue: t.dueAt ?? null, changeSetId, meta: { leadId: t.leadId, subject: t.subject, ruleNote: t.ruleNote ?? null } });
  }
  for (const l of cs.leadCreates) {
    const r = ok.get(l.id);
    if (r) out.push({ actor, action: 'crm.lead_create', entity: 'lead', entityId: r.createdId ?? null, changeSetId, meta: { fromLeadId: l.fromLeadId } });
  }
  for (const s of cs.stateChanges) {
    if (!ok.has(s.id)) continue;
    const oldState = crmNow[snapshotKey('lead', s.leadId, 'statecode')] ?? null;
    const oldStatus = crmNow[snapshotKey('lead', s.leadId, 'statuscode')] ?? null;
    out.push({ actor, action: 'crm.state_change', entity: 'lead', entityId: s.leadId, field: 'statecode', oldValue: oldState, newValue: s.statecode, changeSetId });
    out.push({ actor, action: 'crm.state_change', entity: 'lead', entityId: s.leadId, field: 'statuscode', oldValue: oldStatus, newValue: s.statuscode, changeSetId });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Discard, revert
// ---------------------------------------------------------------------------------------------------------------------

export async function discardChangeSet(ctx: ChangeSetCtx, id: string, options: AccessOptions = {}): Promise<ChangeSet> {
  const row = await loadOwnedRow(ctx, id);
  assertGenericAccess(row, options);
  // An interrupted push (still «pending» long after the click) may be discarded – pushing it again could write twice.
  const stalePending = row.status === 'pending' && ctx.now().getTime() - row.updatedAt.getTime() > PENDING_STALE_MINUTES * 60_000;
  if (!['draft', 'conflict', 'failed'].includes(row.status) && !stalePending) throw conflict('Nur Entwürfe können verworfen werden');
  if (row.results.some((r) => r.ok)) throw conflict('Teil der Änderungen ist schon im CRM – bitte «Erneut versuchen» oder zurücksetzen');
  const [updated] = await ctx.db
    .update(changeSets)
    .set({ status: 'discarded', updatedAt: ctx.now() })
    .where(and(eq(changeSets.id, id), eq(changeSets.status, row.status)))
    .returning();
  if (!updated) throw conflict('Der Entwurf wurde inzwischen geändert – bitte neu laden');
  await auditMany(ctx.db, [pushAudit(ctx, row, 'changeset.discard', { stalePending })]);
  return toChangeSet(updated);
}

export interface RevertResponse {
  revert: ChangeSet;
  skipped: { field: string; label: string; crmNow: unknown }[];
}

/**
 * Undo a pushed change set («Rückgängig» right after the click, «Zurücksetzen» from the protocol for admins).
 * Fields changed again in the CRM since the push are skipped – nothing is silently overwritten.
 */
export async function revertChangeSet(ctx: ChangeSetCtx, id: string, options: { reason?: string } = {}): Promise<RevertResponse> {
  const row = await loadOwnedRow(ctx, id);
  if (row.status !== 'pushed' && !(row.status === 'failed' && row.results.some((r) => r.ok))) {
    throw conflict('Nur gespeicherte Änderungen können zurückgesetzt werden');
  }
  if (!isAdmin(ctx.auth)) {
    const at = (row.pushedAt ?? row.updatedAt).getTime();
    if (row.createdBy !== ctx.auth.user.id || ctx.now().getTime() - at > UNDO_WINDOW_MINUTES * 60_000) {
      throw forbidden(`Rückgängig ist nur in den ersten ${UNDO_WINDOW_MINUTES} Minuten möglich – danach über den Admin`);
    }
  }
  const cs = toChangeSet(row);
  const crmNow = await rereadCrm(ctx.crm, cs);
  const plan = buildRevertDraft(cs, crmNow, options);
  const [revertRow] = await ctx.db
    .insert(changeSets)
    // No call-session link: the revert must not touch the call's status.
    .values({ ...plan.draft, callSessionId: null, status: 'draft', createdBy: ctx.auth.user.id, createdAt: ctx.now(), updatedAt: ctx.now() })
    .returning();
  const pushed = await executePush(ctx, revertRow, toChangeSet(revertRow), await rereadCrm(ctx.crm, plan.draft), [], { revertOf: row.id });
  // Reverting a call's result cancels its phone call in the CRM → the call is open again (wrap-up), so the result can
  // be chosen anew and the call shows up in the Pendenzen until then («kein Anruf bleibt ohne CRM-Eintrag»).
  // «Nicht erreicht» has its own undo in the calls module (back to «wählt»).
  if (row.kind === 'call_result' && row.callSessionId && pushed.status === 'pushed') {
    await ctx.db
      .update(callSessions)
      .set({ status: 'ended', resultGroup: null, changeSetId: null, crmPhonecallId: null, updatedAt: ctx.now() })
      .where(and(eq(callSessions.id, row.callSessionId), eq(callSessions.changeSetId, row.id), eq(callSessions.status, 'completed')));
  }
  await auditMany(ctx.db, [{ actor: ctx.auth.actor, action: 'changeset.revert', entity: 'change_set', entityId: row.id, changeSetId: row.id, meta: { revertChangeSetId: revertRow.id, skipped: plan.skipped.map((s) => s.field), reason: options.reason ?? null } }]);
  return { revert: pushed.changeSet, skipped: plan.skipped };
}
