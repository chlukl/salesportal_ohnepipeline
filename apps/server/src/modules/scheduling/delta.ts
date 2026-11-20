/**
 * Watching portal bookings (INTENT 6.11): delta query per organizer calendar every few minutes, matched by Termin-ID.
 *
 * | Event                                                        | Reaction                                                     |
 * |--------------------------------------------------------------|--------------------------------------------------------------|
 * | deleted / cancelled by the organizer, or main contact declines | Absage: message to Markus (name, company, phone, link),     |
 * |                                                              | remove blockers + briefing entries, booking «abgesagt»      |
 * |                                                              | (call status only after Markus' click)                      |
 * | another external person declines                             | hint to Markus and the sales, meeting stays                  |
 * | Nico or the sales declines                                   | warning to Markus «neu planen», meeting + blockers stay      |
 * | moved                                                        | move blockers + briefing entries, booking «verschoben»       |
 *
 * Cancellations and moves also update the CRM appointment of the booking (cancelled / new time) and `kls_buchung`.
 * Background task without lead fields → no approval (INTENT 5). Idempotent: state is compared with the booking row.
 */
import { formatShortDate, localHhmm, type CalendarEvent, type ExternalAttendee, type NotificationKind } from '@sales-portal/shared';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { bookings, notifications, syncState } from '../../db/schema';
import { audit } from '../../lib/audit';
import { syncCrmAppointment, syncCrmBookingRecord, SYSTEM_ACTOR } from './crmSync';
import {
  ACTIVE_STATUSES,
  bookingMailboxes,
  ensureBlockers,
  getBookingRules,
  moveLinkedEvents,
  PROP_REF,
  PROP_ROLE,
  removeLinkedEvents,
  type BookingRow,
} from './service';
import type { SchedulingDeps } from './util';

const lower = (s: string) => s.trim().toLowerCase();
const tokenKey = (mailbox: string) => `calendar.delta:${lower(mailbox)}`;

export interface DeltaStats {
  mailboxes: number;
  changed: number;
  cancelled: number;
  moved: number;
  hints: number;
  warnings: number;
  errors: number;
}

async function readToken(db: Db, mailbox: string): Promise<string | null> {
  const [row] = await db.select({ value: syncState.value }).from(syncState).where(eq(syncState.key, tokenKey(mailbox))).limit(1);
  const v = row?.value as { token?: string } | undefined;
  return v?.token ?? null;
}

async function writeToken(db: Db, mailbox: string, token: string, now: Date): Promise<void> {
  await db
    .insert(syncState)
    .values({ key: tokenKey(mailbox), value: { token, polledAt: now.toISOString() }, updatedAt: now })
    .onConflictDoUpdate({ target: syncState.key, set: { value: { token, polledAt: now.toISOString() }, updatedAt: now } });
}

/** Active bookings that are still worth watching (not long over). */
async function watchedBookings(db: Db, now: Date): Promise<BookingRow[]> {
  return db
    .select()
    .from(bookings)
    .where(and(inArray(bookings.status, ACTIVE_STATUSES), gt(bookings.endAt, new Date(now.getTime() - 86_400_000))));
}

async function notify(
  db: Db,
  args: { userIds: (string | null)[]; kind: NotificationKind; title: string; body: string; booking: BookingRow; severity: 'info' | 'warning' | 'error'; dedupe?: boolean },
): Promise<number> {
  let n = 0;
  for (const userId of [...new Set(args.userIds.filter((x): x is string => !!x))]) {
    if (args.dedupe) {
      const existing = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.kind, args.kind),
            eq(notifications.entityId, args.booking.id),
            eq(notifications.title, args.title),
            isNull(notifications.doneAt),
          ),
        )
        .limit(1);
      if (existing.length) continue;
    }
    await db.insert(notifications).values({
      userId,
      kind: args.kind,
      title: args.title,
      body: args.body,
      link: `/lead/${encodeURIComponent(args.booking.leadId)}`,
      entity: 'booking',
      entityId: args.booking.id,
      severity: args.severity,
    });
    n++;
  }
  return n;
}

function when(row: Pick<BookingRow, 'startAt'>): string {
  return `${formatShortDate(row.startAt)} ${localHhmm(row.startAt)} Uhr`;
}

export type CancelReason = 'deleted' | 'organizer_cancelled' | 'main_contact_declined';

const REASON_TEXT: Record<CancelReason, string> = {
  deleted: 'Der Termin wurde im Kalender gelöscht.',
  organizer_cancelled: 'Der Termin wurde vom Organisator abgesagt.',
  main_contact_declined: 'Die Ansprechperson hat die Einladung abgelehnt.',
};

/** Absage: notify Markus, remove blockers + briefing entries, mark the booking cancelled. */
export async function handleCancellation(deps: SchedulingDeps, row: BookingRow, reason: CancelReason): Promise<void> {
  const { db } = deps;
  const rules = await getBookingRules(db);
  let removed = 0;
  try {
    removed = await removeLinkedEvents(deps.systemCalendar, db, rules, row);
  } catch (err) {
    deps.log.warn({ err: (err as Error).message, bookingId: row.id }, 'linked entries could not be removed');
  }
  const [cancelled] = await db
    .update(bookings)
    .set({ status: 'cancelled', blockerEventIds: [], briefingEventIds: [], updatedAt: deps.now() })
    .where(eq(bookings.id, row.id))
    .returning();
  // CRM: the appointment no longer counts as «Termin» / real contact; kls_buchung «abgesagt».
  const crm = await syncCrmAppointment(deps, cancelled, { kind: 'cancel' }, SYSTEM_ACTOR);
  await syncCrmBookingRecord(deps, cancelled, SYSTEM_ACTOR);
  const lead = await deps.adapters.crm.getLead(row.leadId).catch(() => null);
  const phone = lead?.primaryPhone?.display ?? null;
  const person = row.leadName ?? lead?.fullname ?? 'Ansprechperson';
  await notify(db, {
    userIds: [row.createdBy],
    kind: 'booking_cancelled',
    severity: 'warning',
    title: `Termin abgesagt: ${row.companyName ?? 'Lead'}`,
    body: [`${person} · ${row.companyName ?? ''}${phone ? ` · ${phone}` : ''}`, `Termin vom ${when(row)}. ${REASON_TEXT[reason]}`, 'Blocker und Briefing-Eintrag sind entfernt. Bitte Anrufstatus im Portal setzen.'].join('\n'),
    booking: row,
  });
  await audit(db, {
    actor: 'system',
    action: 'scheduling.booking_cancelled',
    entity: 'booking',
    entityId: row.id,
    field: 'status',
    oldValue: row.status,
    newValue: 'cancelled',
    meta: { bookingRef: row.bookingRef, reason, removedLinked: removed, crmAppointment: crm },
  });
  await deps.briefing?.deleted(row.id);
}

/** Verschoben: move blockers + briefing entries, update the booking, inform Markus and the sales. */
export async function handleMove(deps: SchedulingDeps, row: BookingRow, ev: CalendarEvent): Promise<void> {
  const { db } = deps;
  const rules = await getBookingRules(db);
  const start = new Date(ev.start);
  const end = new Date(ev.end);
  try {
    await moveLinkedEvents(deps.systemCalendar, db, rules, row, start, end);
  } catch (err) {
    deps.log.warn({ err: (err as Error).message, bookingId: row.id }, 'linked entries could not be moved');
  }
  const [updated] = await db
    .update(bookings)
    .set({ startAt: start, endAt: end, status: 'rescheduled', updatedAt: deps.now() })
    .where(eq(bookings.id, row.id))
    .returning();
  // Blockers that could not be moved are re-created at the new time.
  let current = updated;
  try {
    current = await ensureBlockers(deps.systemCalendar, db, updated, rules);
  } catch {
    await deps.enqueue('scheduling.ensure_blockers', { bookingId: row.id }, { dedupeKey: `blockers:${row.id}` });
  }
  // CRM: appointment at the new time, kls_buchung «verschoben».
  const crm = await syncCrmAppointment(deps, current, { kind: 'move', start, end, previousStart: row.startAt }, SYSTEM_ACTOR);
  await syncCrmBookingRecord(deps, current, SYSTEM_ACTOR);
  await notify(db, {
    userIds: [row.createdBy, row.salesUserId],
    kind: 'booking_rescheduled',
    severity: 'info',
    title: `Termin verschoben: ${row.companyName ?? 'Lead'}`,
    body: `Neu am ${when(updated)} (vorher ${when(row)}). Blocker und Briefing-Eintrag sind mitverschoben.`,
    booking: row,
  });
  await audit(db, {
    actor: 'system',
    action: 'scheduling.booking_moved',
    entity: 'booking',
    entityId: row.id,
    field: 'start',
    oldValue: row.startAt.toISOString(),
    newValue: start.toISOString(),
    meta: { bookingRef: row.bookingRef, crmAppointment: crm },
  });
  await deps.briefing?.updated(row.id);
}

/** Applies one changed organizer event to its booking. Returns what happened. */
export async function applyEventChange(
  deps: SchedulingDeps,
  row: BookingRow,
  ev: CalendarEvent,
  internal: { specialist: string; sales: string },
): Promise<'cancelled' | 'moved' | 'hint' | 'warning' | 'none'> {
  const { db } = deps;
  if (ev.isCancelled) {
    await handleCancellation(deps, row, 'organizer_cancelled');
    return 'cancelled';
  }
  let result: 'moved' | 'hint' | 'warning' | 'none' = 'none';
  const responses = new Map(ev.attendees.map((a) => [lower(a.email), a.response]));

  // External attendees: store responses, react on new declines.
  let changedResponses = false;
  const externals: ExternalAttendee[] = row.externalAttendees.map((a) => {
    const r = responses.get(lower(a.email));
    if (!r || r === 'organizer' || r === a.response) return a;
    changedResponses = true;
    return { ...a, response: r };
  });
  const newlyDeclined = externals.filter((a, i) => a.response === 'declined' && row.externalAttendees[i].response !== 'declined');
  if (newlyDeclined.some((a) => a.isMainContact)) {
    await db.update(bookings).set({ externalAttendees: externals, updatedAt: deps.now() }).where(eq(bookings.id, row.id));
    await handleCancellation(deps, { ...row, externalAttendees: externals }, 'main_contact_declined');
    return 'cancelled';
  }
  if (changedResponses) {
    await db.update(bookings).set({ externalAttendees: externals, updatedAt: deps.now() }).where(eq(bookings.id, row.id));
  }
  for (const a of newlyDeclined) {
    await notify(db, {
      userIds: [row.createdBy, row.salesUserId],
      kind: 'attendee_declined',
      severity: 'info',
      title: `Absage einer weiteren Person: ${row.companyName ?? 'Lead'}`,
      body: `${a.name || a.email} kommt nicht zum Termin vom ${when(row)}. Der Termin bleibt bestehen.`,
      booking: row,
    });
    result = 'hint';
  }

  // Nico or the sales declines → «neu planen» (meeting and blockers stay until Markus re-plans).
  for (const [who, email] of [
    ['Nico', internal.specialist],
    ['Sales', internal.sales],
  ] as const) {
    if (responses.get(lower(email)) !== 'declined') continue;
    const name = who === 'Nico' ? 'Der AI-Spezialist' : 'Der Sales';
    const created = await notify(db, {
      userIds: [row.createdBy],
      kind: 'internal_declined',
      severity: 'warning',
      title: `Neu planen: ${row.companyName ?? 'Lead'}`,
      body: `${name} (${email}) hat den Termin vom ${when(row)} abgelehnt. Termin und Blocker bleiben, bis du neu planst.`,
      booking: row,
      dedupe: true,
    });
    if (created) result = 'warning';
  }

  // Moved (start or end differ from the booking).
  if (new Date(ev.start).getTime() !== row.startAt.getTime() || new Date(ev.end).getTime() !== row.endAt.getTime()) {
    await handleMove(deps, { ...row, externalAttendees: externals }, ev);
    result = 'moved';
  }
  return result;
}

/** One polling round over all organizer calendars of watched bookings. */
export async function pollCalendarChanges(deps: SchedulingDeps): Promise<DeltaStats> {
  const { db } = deps;
  const now = deps.now();
  const rules = await getBookingRules(db);
  const stats: DeltaStats = { mailboxes: 0, changed: 0, cancelled: 0, moved: 0, hints: 0, warnings: 0, errors: 0 };
  const watched = await watchedBookings(db, now);
  if (watched.length === 0) return stats;

  // Organizer = sales of the booking.
  const byMailbox = new Map<string, BookingRow[]>();
  const internals = new Map<string, { specialist: string; sales: string }>();
  for (const row of watched) {
    const mb = await bookingMailboxes(db, rules, row);
    internals.set(row.id, mb);
    const key = lower(mb.sales);
    byMailbox.set(key, [...(byMailbox.get(key) ?? []), row]);
  }

  for (const mailbox of byMailbox.keys()) {
    stats.mailboxes++;
    try {
      const token = await readToken(db, mailbox);
      const delta = await deps.systemCalendar.delta(mailbox, token);
      // Re-read the bookings of this mailbox (previous events in this round may have changed them).
      const rows = (await watchedBookings(db, now)).filter((r) => lower(internals.get(r.id)?.sales ?? '') === mailbox);
      const byRef = new Map(rows.map((r) => [r.bookingRef, r]));
      const byEventId = new Map(rows.filter((r) => r.eventId).map((r) => [r.eventId!, r]));
      const handled = new Set<string>();

      for (const id of delta.deleted) {
        const row = byEventId.get(id);
        if (!row || handled.has(row.id)) continue;
        handled.add(row.id);
        stats.changed++;
        await handleCancellation(deps, row, 'deleted');
        stats.cancelled++;
      }
      for (const ev of delta.changed) {
        if (ev.extendedProperties?.[PROP_ROLE]) continue; // own blockers / briefing entries
        const row = byRef.get(ev.extendedProperties?.[PROP_REF] ?? '') ?? byEventId.get(ev.id);
        if (!row || handled.has(row.id) || row.eventId !== ev.id) continue;
        handled.add(row.id);
        const fresh = (await db.select().from(bookings).where(eq(bookings.id, row.id)).limit(1))[0];
        if (!fresh || !ACTIVE_STATUSES.includes(fresh.status)) continue;
        const outcome = await applyEventChange(deps, fresh, ev, internals.get(row.id)!);
        if (outcome !== 'none') stats.changed++;
        if (outcome === 'cancelled') stats.cancelled++;
        if (outcome === 'moved') stats.moved++;
        if (outcome === 'hint') stats.hints++;
        if (outcome === 'warning') stats.warnings++;
      }
      await writeToken(db, mailbox, delta.nextToken, now);
    } catch (err) {
      stats.errors++;
      deps.log.warn({ err: (err as Error).message, mailbox: mailbox.replace(/^[^@]+/, '***') }, 'calendar delta failed');
    }
  }
  return stats;
}

/** Worker job: (re)create missing blockers of one booking. */
export async function ensureBlockersJob(deps: SchedulingDeps, bookingId: string): Promise<void> {
  const [row] = await deps.db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!row) return;
  const rules = await getBookingRules(deps.db);
  await ensureBlockers(deps.systemCalendar, deps.db, row, rules);
}

