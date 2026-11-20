/**
 * CRM side of a booking after it exists (INTENT 6.6, 6.11, 6.17, 8):
 *  - the appointment activity of the booking change set follows cancellations and moves (cancelled → statecode 2,
 *    moved → scheduledstart/scheduledend). Background task without lead fields → no approval (INTENT 5). While the
 *    change set is still a draft, the draft itself is adjusted (moved) or discarded (cancelled) instead.
 *  - the `kls_buchung` record (Termin-ID, status, origin) is written on create, move and cancel when the CRM adapter
 *    supports it (`LiveCrmAdapter.upsertBooking`; the mock CRM has no such table).
 */
import type { Actor, ActivityOp, Booking, ChangeSet } from '@sales-portal/shared';
import { and, desc, eq, sql, type InferSelectModel } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { auditLog, bookings, changeSets } from '../../db/schema';
import { audit } from '../../lib/audit';
import { toBooking, type BookingRow } from './service';
import type { SchedulingDeps } from './util';

type ChangeSetRow = InferSelectModel<typeof changeSets>;

/** Termin-ID of the booking, kept in the change set's baseSnapshot (not a CRM field, ignored by the conflict check). */
export const META_BOOKING_REF = 'meta:bookingRef';
/** Booking made during a call whose result is still open: fields + follow-up come with the call result. */
export const META_WITH_CALL_RESULT = 'meta:withCallResult';

export const SYSTEM_ACTOR: Actor = { kind: 'system', userId: null, displayName: 'Sales-Portal', crmUserId: null, email: null };

/** The change set that carries the booking's appointment activity. */
export async function bookingChangeSet(db: Db, row: Pick<BookingRow, 'id' | 'leadId' | 'bookingRef'>): Promise<ChangeSetRow | null> {
  const [byRef] = await db
    .select()
    .from(changeSets)
    .where(and(eq(changeSets.leadId, row.leadId), eq(changeSets.kind, 'booking'), sql`${changeSets.baseSnapshot} ->> ${META_BOOKING_REF} = ${row.bookingRef}`))
    .orderBy(desc(changeSets.createdAt))
    .limit(1);
  if (byRef) return byRef;
  // Bookings created before the Termin-ID was stored in the change set: the creation audit links both.
  const [created] = await db
    .select({ changeSetId: auditLog.changeSetId })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'scheduling.booking_create'), eq(auditLog.entityId, row.id)))
    .limit(1);
  if (!created?.changeSetId) return null;
  const [byAudit] = await db.select().from(changeSets).where(eq(changeSets.id, created.changeSetId)).limit(1);
  return byAudit ?? null;
}

export type AppointmentChange = { kind: 'cancel' } | { kind: 'move'; start: Date; end: Date; previousStart?: Date };
export type AppointmentSyncResult = 'crm_updated' | 'draft_updated' | 'draft_discarded' | 'failed' | 'none';

const OPEN_DRAFT: ChangeSetRow['status'][] = ['draft', 'conflict', 'failed'];

/** Keeps the CRM appointment (or its not yet approved draft) in line with the booking. Never throws. */
export async function syncCrmAppointment(deps: SchedulingDeps, row: BookingRow, change: AppointmentChange, actor: Actor): Promise<AppointmentSyncResult> {
  try {
    return await syncCrmAppointmentUnsafe(deps, row, change, actor);
  } catch (err) {
    deps.log.warn({ err: (err as Error).message, bookingId: row.id }, 'CRM appointment could not be updated');
    return 'failed';
  }
}

async function syncCrmAppointmentUnsafe(deps: SchedulingDeps, row: BookingRow, change: AppointmentChange, actor: Actor): Promise<AppointmentSyncResult> {
  const { db } = deps;
  const cs = await bookingChangeSet(db, row);
  if (!cs || cs.status === 'discarded') return 'none';
  const op = cs.activities.find((a) => a.type === 'appointment' && a.action === 'create');
  if (!op) return 'none';
  const created = cs.results.find((r) => r.opId === op.id && r.ok && r.createdId);
  const auditActor = actor.kind === 'system' ? ('system' as const) : { userId: actor.userId, displayName: actor.displayName };

  if (created?.createdId) {
    const update: ActivityOp = {
      id: `${op.id}-${change.kind}`,
      action: 'update',
      type: 'appointment',
      activityId: created.createdId,
      leadId: op.leadId,
      subject: op.subject,
      text: op.text,
      direction: op.direction,
      ...(change.kind === 'cancel' ? { statecode: 2 } : { start: change.start.toISOString(), end: change.end.toISOString() }),
    };
    const nowIso = deps.now().toISOString();
    const minimal: ChangeSet = {
      id: cs.id,
      leadId: row.leadId,
      callSessionId: null,
      kind: 'booking',
      ruleKey: null,
      ruleVersion: null,
      operations: [],
      activities: [update],
      tasks: [],
      notes: [],
      stateChanges: [],
      leadCreates: [],
      baseSnapshot: {},
      status: 'pending',
      conflicts: [],
      results: [],
      createdBy: row.createdBy,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const applied = await deps.adapters.crm.applyChangeSet(minimal, actor);
    const ok = applied.results.some((r) => r.opId === update.id && r.ok);
    await audit(db, {
      actor: auditActor,
      action: ok ? 'crm.activity_update' : 'crm.activity_update_failed',
      entity: 'appointment',
      entityId: created.createdId,
      field: change.kind === 'cancel' ? 'statecode' : 'scheduledstart',
      oldValue: change.kind === 'cancel' ? null : (change.previousStart?.toISOString() ?? null),
      newValue: change.kind === 'cancel' ? 2 : change.start.toISOString(),
      changeSetId: cs.id,
      meta: { leadId: row.leadId, bookingRef: row.bookingRef, reason: change.kind === 'cancel' ? 'booking_cancelled' : 'booking_moved' },
    });
    if (!ok) deps.log.warn({ bookingId: row.id }, 'CRM appointment update failed');
    return ok ? 'crm_updated' : 'failed';
  }

  if (!OPEN_DRAFT.includes(cs.status)) return 'none'; // pending push: the pusher wins, nothing to adjust safely
  const now = deps.now();
  // Guarded by the status read above: a push that started meanwhile is never changed underneath.
  const sameDraft = and(eq(changeSets.id, cs.id), eq(changeSets.status, cs.status));
  if (change.kind === 'cancel') {
    if (!cs.results.some((r) => r.ok)) {
      // Nothing of it is in the CRM yet: a cancelled meeting must not be approved later («Termin vereinbart»).
      await db.update(changeSets).set({ status: 'discarded', updatedAt: now }).where(sameDraft);
      await audit(db, {
        actor: auditActor,
        action: 'changeset.discard',
        entity: 'change_set',
        entityId: cs.id,
        changeSetId: cs.id,
        meta: { leadId: row.leadId, bookingRef: row.bookingRef, reason: 'booking_cancelled' },
      });
      return 'draft_discarded';
    }
    await db
      .update(changeSets)
      .set({ activities: cs.activities.filter((a) => a.id !== op.id), updatedAt: now })
      .where(sameDraft);
    return 'draft_updated';
  }
  await db
    .update(changeSets)
    .set({
      activities: cs.activities.map((a) => (a.id === op.id ? { ...a, start: change.start.toISOString(), end: change.end.toISOString() } : a)),
      updatedAt: now,
    })
    .where(sameDraft);
  return 'draft_updated';
}

// ---------------------------------------------------------------------------------------------------------------------
// kls_buchung
// ---------------------------------------------------------------------------------------------------------------------

interface BookingRecordWriter {
  upsertBooking(booking: Booking, crmBookingId: string | null, actor: Actor): Promise<string>;
}

export function supportsBookingRecord(crm: unknown): crm is BookingRecordWriter {
  return !!crm && typeof (crm as Partial<BookingRecordWriter>).upsertBooking === 'function';
}

export const SYNC_BOOKING_JOB = 'scheduling.sync_crm_booking';

/** Writes the booking to `kls_buchung` (id kept in `bookings.crm_booking_id`). Failures are retried by a job. */
export async function syncCrmBookingRecord(deps: SchedulingDeps, row: BookingRow, actor: Actor, options: { retry?: boolean } = {}): Promise<boolean> {
  const crm = deps.adapters.crm as unknown;
  if (!supportsBookingRecord(crm)) return false;
  try {
    const id = await crm.upsertBooking(toBooking(row), row.crmBookingId, actor);
    if (id && id !== row.crmBookingId) {
      await deps.db.update(bookings).set({ crmBookingId: id, updatedAt: deps.now() }).where(eq(bookings.id, row.id));
    }
    return true;
  } catch (err) {
    deps.log.warn({ err: (err as Error).message, bookingId: row.id }, 'kls_buchung could not be written');
    if (options.retry === false) throw err;
    await deps.enqueue(SYNC_BOOKING_JOB, { bookingId: row.id }, { dedupeKey: `crm-booking:${row.id}` }).catch(() => undefined);
    return false;
  }
}

/** Worker job: (re)write the current state of one booking to `kls_buchung`. Throws so the queue retries. */
export async function syncCrmBookingJob(deps: SchedulingDeps, bookingId: string): Promise<void> {
  const [row] = await deps.db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!row) return;
  await syncCrmBookingRecord(deps, row, SYSTEM_ACTOR, { retry: false });
}
