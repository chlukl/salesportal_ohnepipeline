/**
 * Scheduling service (INTENT 6.6, 6.8, 6.10, 6.11, 6.17): slots, booking incl. blockers, linked calendar entries,
 * change sets for the approval preview. Slot / proposal rules live in packages/shared/src/scheduling.ts.
 */
import { randomBytes } from 'node:crypto';
import {
  buildCallStatusChangeSet,
  buildSchedulingChangeSet,
  bookingSubject,
  checkAttendeeEmail,
  DEFAULT_RESULT_GROUP_RULES,
  emailDomain,
  findSlotsFor,
  isAllowedStart,
  isSlotFree,
  isMailboxFree,
  localIsoDate,
  participantsFor,
  personPlaceholders,
  fillTemplate,
  type Actor,
  type Booking,
  type BookingRules,
  type CalendarEvent,
  type ChangeSetDraft,
  type ExternalAttendee,
  type Lead,
  type MailboxSchedule,
  type ResultGroupKey,
  type ResultGroupRule,
  type Slot,
} from '@sales-portal/shared';
import { and, desc, eq, gt, inArray, lt, sql, type InferSelectModel } from 'drizzle-orm';
import type { RequestAuth } from '../../auth/rbac';
import type { Db } from '../../db/client';
import { bookings, callSessions, changeSets, resultGroupRules, templates, users } from '../../db/schema';
import type { Adapters } from '../../integrations';
import { audit } from '../../lib/audit';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { getSetting } from '../../lib/settings';
import { META_BOOKING_REF, META_WITH_CALL_RESULT, syncCrmAppointment, syncCrmBookingRecord } from './crmSync';
import { addMinutesIso, withBookingLock, type SchedulingDeps } from './util';


type BookingRow = InferSelectModel<typeof bookings>;

/** Extended properties on calendar entries (Termin-ID like `KlsTerminStand` in «Kalender Termin-Updates»). */
export const PROP_REF = 'KlsTerminId';
export const PROP_ROLE = 'KlsRolle';
export type LinkedRole = 'blocker' | 'briefing';

export const ACTIVE_STATUSES: Booking['status'][] = ['booked', 'rescheduled'];

export async function getBookingRules(db: Db): Promise<BookingRules> {
  return getSetting(db, 'booking.rules');
}

export function toBooking(r: BookingRow): Booking & { body: string | null; briefingMailSentAt: string | null } {
  return {
    id: r.id,
    bookingRef: r.bookingRef,
    leadId: r.leadId,
    leadName: r.leadName,
    companyName: r.companyName,
    callSessionId: r.callSessionId,
    salesUserId: r.salesUserId,
    specialistUserId: r.specialistUserId,
    extraCall: r.extraCall,
    start: r.startAt.toISOString(),
    end: r.endAt.toISOString(),
    status: r.status,
    origin: r.origin,
    eventId: r.eventId,
    iCalUId: r.iCalUId,
    blockerEventIds: r.blockerEventIds ?? [],
    briefingEventIds: r.briefingEventIds ?? [],
    needsPreparation: r.needsPreparation,
    preparationNote: r.preparationNote,
    briefingStatus: r.briefingStatus,
    externalAttendees: r.externalAttendees ?? [],
    subject: r.subject,
    body: r.body,
    briefingMailSentAt: r.briefingMailSentAt ? r.briefingMailSentAt.toISOString() : null,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// =====================================================================================================================
// Users, templates, rules
// =====================================================================================================================

export interface PortalPerson {
  id: string | null;
  email: string;
  displayName: string;
}

const lower = (s: string) => s.trim().toLowerCase();

export async function personsByEmail(db: Db, emails: string[]): Promise<Map<string, PortalPerson>> {
  const wanted = [...new Set(emails.map(lower))];
  const rows = wanted.length
    ? await db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(inArray(sql<string>`lower(${users.email})`, wanted))
    : [];
  const map = new Map<string, PortalPerson>();
  for (const email of wanted) {
    const row = rows.find((r) => lower(r.email) === email);
    map.set(email, row ? { id: row.id, email: row.email, displayName: row.displayName } : { id: null, email, displayName: email.split('@')[0] });
  }
  return map;
}

export async function emailsOfUsers(db: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (list.length === 0) return new Map();
  const rows = await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, r.email]));
}

export async function getTemplate(db: Db, key: string): Promise<{ subject: string | null; body: string } | null> {
  const [row] = await db.select({ subject: templates.subject, body: templates.body }).from(templates).where(eq(templates.key, key)).limit(1);
  return row ?? null;
}

/** Active (newest) version of a result-group rule; falls back to the INTENT defaults. */
export async function getActiveRule(db: Db, key: ResultGroupKey): Promise<ResultGroupRule> {
  const [row] = await db
    .select({ definition: resultGroupRules.definition })
    .from(resultGroupRules)
    .where(and(eq(resultGroupRules.key, key), eq(resultGroupRules.isActive, true)))
    .orderBy(desc(resultGroupRules.version))
    .limit(1);
  return row?.definition ?? DEFAULT_RESULT_GROUP_RULES.find((r) => r.key === key)!;
}

export function internalDomains(rules: BookingRules): string[] {
  return [...new Set([rules.defaultSalesEmail, rules.specialistEmail, rules.extraCallSalesEmail].map((e) => emailDomain(e)).filter((d): d is string => !!d))];
}

export function originOf(lead: Pick<Lead, 'campaign'>): Booking['origin'] {
  return lead.campaign?.fromCampaign || lead.campaign?.inCampaign ? 'campaign' : 'coldcall';
}

export async function loadLead(adapters: Adapters, leadId: string): Promise<Lead> {
  const lead = await adapters.crm.getLead(leadId);
  if (!lead) throw notFound('Lead nicht gefunden');
  return lead;
}

// =====================================================================================================================
// Slots
// =====================================================================================================================

export interface ParticipantInfo {
  extraCall: boolean;
  sales: PortalPerson;
  specialist: PortalPerson;
  /** Zusatzcall: Manuel (only offered when he cannot). */
  unavailable: PortalPerson | null;
}

export async function participantInfo(db: Db, rules: BookingRules, extraCall: boolean): Promise<ParticipantInfo> {
  const p = participantsFor(rules, extraCall);
  const people = await personsByEmail(db, [p.salesEmail, p.specialistEmail, rules.defaultSalesEmail]);
  return {
    extraCall,
    sales: people.get(lower(p.salesEmail))!,
    specialist: people.get(lower(p.specialistEmail))!,
    unavailable: p.onlyWhenUnavailable ? people.get(lower(p.onlyWhenUnavailable))! : null,
  };
}

/** Mailboxes whose free/busy we need (incl. Manuel for the Zusatzcall rule). */
export function scheduleMailboxes(rules: BookingRules, extraCall: boolean): string[] {
  const p = participantsFor(rules, extraCall);
  return [...p.attendees, ...(p.onlyWhenUnavailable ? [p.onlyWhenUnavailable] : [])];
}

export interface SlotSearchResult {
  slots: Slot[];
  participants: ParticipantInfo;
  /** Mailboxes whose calendar could not be read (→ no slots, never book blindly). */
  unavailableCalendars: string[];
}

export async function searchSlots(
  deps: SchedulingDeps,
  args: { from: Date; to: Date; extraCall: boolean },
): Promise<SlotSearchResult> {
  const rules = await getBookingRules(deps.db);
  const mailboxes = scheduleMailboxes(rules, args.extraCall);
  // Buffers can reach into the previous / next day – load a little more.
  const schedules = await deps.calendar.getSchedule(
    mailboxes,
    addMinutesIso(args.from, -rules.bufferBeforeMinutes),
    addMinutesIso(args.to, rules.bufferAfterMinutes + rules.durationMinutes),
  );
  const slots = findSlotsFor({ from: args.from, to: args.to, schedules, rules, now: deps.now(), extraCall: args.extraCall });
  return {
    slots,
    participants: await participantInfo(deps.db, rules, args.extraCall),
    unavailableCalendars: schedules.filter((s) => s.error).map((s) => s.email),
  };
}

// =====================================================================================================================
// Booking
// =====================================================================================================================

export interface CreateBookingInput {
  leadId: string;
  callSessionId?: string | null;
  start: string;
  extraCall: boolean;
  subject: string;
  body: string;
  attendees: { email: string; name?: string | null; isMainContact?: boolean }[];
  needsPreparation: boolean;
  preparationNote?: string | null;
  decisionMakerInMeeting?: boolean;
  budgetMentioned?: boolean;
}

export interface BookingResult {
  booking: Booking;
  changeSetId: string;
  /** Blockers could not be set right away – the worker retries. */
  blockersPending: boolean;
  /**
   * Booked during a call whose result is still open: the change set holds only the appointment; lead fields and the
   * follow-up come with the call result «Termin gebucht» (one approval for the fields, no duplicates).
   */
  withCallResult: boolean;
}

/** Call a booking / proposals mail belongs to (object-level check) and whether its result is still to be approved. */
export interface SchedulingCall {
  id: string;
  /** The caller's result change set will still be approved → fields + follow-up task belong there. */
  resultPending: boolean;
}

const RESULT_PENDING_STATUSES = ['dialing', 'connected', 'ended'];

export async function resolveSchedulingCall(db: Db, auth: RequestAuth, callSessionId: string | null | undefined, leadId: string): Promise<SchedulingCall | null> {
  if (!callSessionId) return null;
  const [call] = await db
    .select({ id: callSessions.id, userId: callSessions.userId, leadId: callSessions.leadId, status: callSessions.status })
    .from(callSessions)
    .where(eq(callSessions.id, callSessionId))
    .limit(1);
  // Other people's calls do not exist for the caller (admins may refer to any call).
  if (!call || (call.userId !== auth.user.id && !auth.effectiveRoles.includes('admin'))) throw notFound('Anruf nicht gefunden');
  if (call.leadId !== leadId) throw badRequest('Der Anruf gehört zu einem anderen Lead');
  return { id: call.id, resultPending: call.userId === auth.user.id && RESULT_PENDING_STATUSES.includes(call.status) };
}

/**
 * Change set of a booking / proposals mail made during a call with an open result: only the activity stays. Lead
 * fields, «Neu → Kontaktiert» and the follow-up task are part of the call result of the same group (INTENT 6.9
 * «eine Vorschau pro Anruf», REGEL_AUFGABEN «keine zweite offene Aufgabe»).
 */
export function activityOnly(draft: ChangeSetDraft): ChangeSetDraft {
  return { ...draft, operations: [], stateChanges: [], tasks: [], leadCreates: [], notes: [], baseSnapshot: { [META_WITH_CALL_RESULT]: true } };
}

function newBookingRef(start: Date): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  const suffix = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `KLS-${localIsoDate(start).replace(/-/g, '')}-${suffix}`;
}

/** Validates external attendees (format + domain plausibility); exactly one main contact. */
export function normalizeAttendees(
  raw: CreateBookingInput['attendees'],
  options: { leadDomain: string | null; internalDomains: string[]; leadEmail: string | null },
): ExternalAttendee[] {
  if (raw.length === 0) throw badRequest('Mindestens eine externe Person einladen');
  const seen = new Set<string>();
  const out: ExternalAttendee[] = [];
  for (const a of raw) {
    const check = checkAttendeeEmail(a.email, { leadDomain: options.leadDomain, internalDomains: options.internalDomains });
    if (!check.ok) throw new AppError(400, 'invalid_attendee', `${check.email || 'Adresse'}: ${check.error}`);
    const key = lower(check.email);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ email: check.email, name: a.name?.trim() || null, isMainContact: !!a.isMainContact, response: 'none' });
  }
  if (!out.some((a) => a.isMainContact)) {
    const byLeadMail = options.leadEmail ? out.find((a) => lower(a.email) === lower(options.leadEmail!)) : undefined;
    (byLeadMail ?? out[0]).isMainContact = true;
  }
  let mainSeen = false;
  for (const a of out) {
    if (a.isMainContact && mainSeen) a.isMainContact = false;
    if (a.isMainContact) mainSeen = true;
  }
  return out;
}

/** Overlapping active bookings of the same internal people (covers the gap until the calendar shows the new event). */
async function overlappingBookings(db: Db, rules: BookingRules, userIds: string[], start: Date, end: Date, excludeId?: string): Promise<BookingRow[]> {
  if (userIds.length === 0) return [];
  const from = new Date(start.getTime() - rules.bufferBeforeMinutes * 60_000 - rules.bufferAfterMinutes * 60_000);
  const to = new Date(end.getTime() + rules.bufferAfterMinutes * 60_000 + rules.bufferBeforeMinutes * 60_000);
  const rows = await db
    .select()
    .from(bookings)
    .where(and(inArray(bookings.status, ACTIVE_STATUSES), lt(bookings.startAt, to), gt(bookings.endAt, from)));
  return rows.filter(
    (r) => r.id !== excludeId && ((r.salesUserId && userIds.includes(r.salesUserId)) || (r.specialistUserId && userIds.includes(r.specialistUserId))),
  );
}

/** Double-booking guard + Zusatzcall rule right before creating / moving (INTENT 6.6). */
function assertBookable(rules: BookingRules, start: Date, schedules: MailboxSchedule[], extraCall: boolean): void {
  const p = participantsFor(rules, extraCall);
  const end = new Date(start.getTime() + rules.durationMinutes * 60_000);
  const slot = { start: start.toISOString(), end: end.toISOString() };
  const own = schedules.filter((s) => p.attendees.some((a) => lower(a) === lower(s.email)));
  if (own.length !== p.attendees.length || !isSlotFree(slot, own, rules)) {
    throw conflict('Dieser Termin ist inzwischen belegt – bitte einen anderen wählen', 'slot_taken');
  }
  if (p.onlyWhenUnavailable) {
    const bs = new Date(start.getTime() - rules.bufferBeforeMinutes * 60_000);
    const be = new Date(end.getTime() + rules.bufferAfterMinutes * 60_000);
    if (isMailboxFree(schedules, p.onlyWhenUnavailable, bs, be)) {
      throw conflict('Zusatzcall nur, wenn Manuel zu dieser Zeit nicht kann – bitte ohne Zusatzcall buchen', 'extra_call_not_allowed');
    }
  }
}

function assertStartAllowed(rules: BookingRules, start: Date, now: Date): void {
  if (Number.isNaN(start.getTime()) || !isAllowedStart(start, rules)) {
    throw unprocessable('Diese Startzeit ist nicht erlaubt (09:00–11:30 oder 14:00–16:00, Mo–Fr)', 'start_not_allowed');
  }
  if (start.getTime() < now.getTime() + rules.bufferBeforeMinutes * 60_000) {
    throw unprocessable('Dieser Termin liegt zu nahe oder in der Vergangenheit', 'start_too_soon');
  }
}

async function insertChangeSet(db: Db, draft: ChangeSetDraft, createdBy: string): Promise<string> {
  const [row] = await db
    .insert(changeSets)
    .values({
      leadId: draft.leadId,
      callSessionId: draft.callSessionId ?? null,
      kind: draft.kind,
      ruleKey: draft.ruleKey ?? null,
      ruleVersion: draft.ruleVersion,
      status: 'draft',
      operations: draft.operations,
      activities: draft.activities,
      tasks: draft.tasks,
      notes: draft.notes,
      stateChanges: draft.stateChanges,
      leadCreates: draft.leadCreates,
      baseSnapshot: draft.baseSnapshot,
      createdBy,
    })
    .returning({ id: changeSets.id });
  return row.id;
}

export { insertChangeSet };

export async function createBooking(deps: SchedulingDeps, auth: RequestAuth, input: CreateBookingInput): Promise<BookingResult> {
  const { db } = deps;
  const rules = await getBookingRules(db);
  const now = deps.now();
  const start = new Date(input.start);
  assertStartAllowed(rules, start, now);
  const end = new Date(start.getTime() + rules.durationMinutes * 60_000);
  const lead = await loadLead(deps.adapters, input.leadId);
  const subject = input.subject.trim() || bookingSubject(rules.subjectTemplate, lead.companyname);
  const externals = normalizeAttendees(input.attendees, {
    leadDomain: lead.domain,
    internalDomains: internalDomains(rules),
    leadEmail: lead.emailaddress1,
  });
  const call = await resolveSchedulingCall(db, auth, input.callSessionId, lead.leadid);
  const people = await participantInfo(db, rules, input.extraCall);
  const p = participantsFor(rules, input.extraCall);
  const bookingRef = newBookingRef(start);

  // Double-booking guard: check → create meeting → insert row under one lock, so two bookings (two people, two tabs,
  // a retried request) can never both pass the check for the same people and time (INTENT 6.6).
  let row: BookingRow = await withBookingLock(deps, async () => {
    const schedules = await deps.calendar.getSchedule(
      scheduleMailboxes(rules, input.extraCall),
      new Date(start.getTime() - rules.bufferBeforeMinutes * 60_000).toISOString(),
      new Date(end.getTime() + rules.bufferAfterMinutes * 60_000).toISOString(),
    );
    assertBookable(rules, start, schedules, input.extraCall);
    const internalIds = [people.sales.id, people.specialist.id].filter((x): x is string => !!x);
    if ((await overlappingBookings(db, rules, internalIds, start, end)).length > 0) {
      throw conflict('Dieser Termin ist inzwischen belegt – bitte einen anderen wählen', 'slot_taken');
    }
    // Teams meeting in the sales' calendar (organizer = sales, created via Markus' delegate access).
    const event = await deps.calendar.createEvent({
      mailbox: p.salesEmail,
      subject,
      body: input.body,
      start: start.toISOString(),
      end: end.toISOString(),
      showAs: 'busy',
      categories: [rules.outlookCategory],
      attendees: [
        { email: p.specialistEmail, name: people.specialist.displayName, type: 'required' },
        ...externals.map((a) => ({ email: a.email, name: a.name ?? null, type: 'required' as const })),
      ],
      extendedProperties: { [PROP_REF]: bookingRef },
      isOnlineMeeting: true,
    });

    try {
      const [inserted] = await db
        .insert(bookings)
        .values({
          bookingRef,
          leadId: lead.leadid,
          leadName: lead.fullname || [lead.firstname, lead.lastname].filter(Boolean).join(' ') || null,
          companyName: lead.companyname,
          callSessionId: call?.id ?? null,
          salesUserId: people.sales.id,
          specialistUserId: people.specialist.id,
          extraCall: input.extraCall,
          startAt: start,
          endAt: end,
          status: 'booked',
          origin: originOf(lead),
          eventId: event.id,
          iCalUId: event.iCalUId,
          blockerEventIds: [],
          briefingEventIds: [],
          needsPreparation: input.needsPreparation,
          preparationNote: input.needsPreparation ? input.preparationNote?.trim() || null : null,
          externalAttendees: externals,
          subject,
          body: input.body,
          createdBy: auth.user.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return inserted;
    } catch (err) {
      // Compensate: no orphaned meeting without a booking row.
      await deps.calendar.deleteEvent(p.salesEmail, event.id).catch(() => undefined);
      throw err;
    }
  });

  // Blockers (background task without lead fields → no approval needed, INTENT 5).
  let blockersPending = false;
  try {
    row = await ensureBlockers(deps.systemCalendar, db, row, rules);
  } catch (err) {
    blockersPending = true;
    deps.log.warn({ err: (err as Error).message, bookingId: row.id }, 'blockers could not be set – retry in worker');
    await deps.enqueue('scheduling.ensure_blockers', { bookingId: row.id }, { dedupeKey: `blockers:${row.id}` });
  }

  // kls_buchung (live CRM only; background record without lead fields).
  await syncCrmBookingRecord(deps, row, auth.actor);

  // CRM part «Termin gebucht» → normal approval preview.
  const rule = await getActiveRule(db, 'meeting_booked');
  const withCallResult = !!call?.resultPending;
  const built = buildSchedulingChangeSet({
    rule,
    lead,
    actor: auth.actor,
    input: { decisionMakerInMeeting: !!input.decisionMakerInMeeting, budgetMentioned: !!input.budgetMentioned },
    callSessionId: call?.id ?? null,
    appointment: {
      subject,
      text: input.body,
      start: start.toISOString(),
      end: end.toISOString(),
      to: externals.map((a) => a.email),
    },
  });
  const draft = withCallResult ? activityOnly(built) : built;
  draft.baseSnapshot = { ...draft.baseSnapshot, [META_BOOKING_REF]: bookingRef };
  const changeSetId = await insertChangeSet(db, draft, auth.user.id);

  await audit(db, {
    actor: auth.actor,
    action: 'scheduling.booking_create',
    entity: 'booking',
    entityId: row.id,
    newValue: { bookingRef, start: start.toISOString(), extraCall: input.extraCall, organizer: p.salesEmail },
    changeSetId,
    meta: { leadId: lead.leadid, eventId: row.eventId, attendees: externals.length, origin: row.origin, withCallResult },
  });
  await deps.briefing?.created(row.id);
  return { booking: toBooking(row), changeSetId, blockersPending, withCallResult };
}

// =====================================================================================================================
// Linked calendar entries (blockers, briefing entries)
// =====================================================================================================================

export interface LinkedEvent {
  event: CalendarEvent;
  role: LinkedRole;
}

/** Calendars that hold the booking's blockers / briefing entries: sales + Nico. */
export async function bookingMailboxes(db: Db, rules: BookingRules, row: Pick<BookingRow, 'salesUserId' | 'specialistUserId' | 'extraCall'>): Promise<{ sales: string; specialist: string }> {
  const emails = await emailsOfUsers(db, [row.salesUserId, row.specialistUserId]);
  return {
    sales: (row.salesUserId && emails.get(row.salesUserId)) || (row.extraCall ? rules.extraCallSalesEmail : rules.defaultSalesEmail),
    specialist: (row.specialistUserId && emails.get(row.specialistUserId)) || rules.specialistEmail,
  };
}

/** Blockers and briefing entries of a booking, found by Termin-ID (or by stored id) around the booked time. */
export async function findLinkedEvents(calendar: Adapters['calendar'], db: Db, rules: BookingRules, row: BookingRow): Promise<LinkedEvent[]> {
  const { sales, specialist } = await bookingMailboxes(db, rules, row);
  const from = new Date(row.startAt.getTime() - 3 * 3_600_000).toISOString();
  const to = new Date(row.endAt.getTime() + 3 * 3_600_000).toISOString();
  const known = new Set([...(row.blockerEventIds ?? []), ...(row.briefingEventIds ?? [])]);
  const out: LinkedEvent[] = [];
  for (const mailbox of [...new Set([sales, specialist].map(lower))]) {
    const events = await calendar.listEvents(mailbox, from, to);
    for (const ev of events) {
      if (ev.id === row.eventId) continue;
      const ref = ev.extendedProperties?.[PROP_REF];
      const role = ev.extendedProperties?.[PROP_ROLE];
      const byRef = ref === row.bookingRef && (role === 'blocker' || role === 'briefing');
      if (!byRef && !known.has(ev.id)) continue;
      out.push({ event: ev, role: role === 'briefing' || (row.briefingEventIds ?? []).includes(ev.id) ? 'briefing' : 'blocker' });
    }
  }
  return out;
}

/** Creates missing blockers (30 min before / after) in the calendars of sales and Nico. Idempotent. */
export async function ensureBlockers(calendar: Adapters['calendar'], db: Db, row: BookingRow, rules: BookingRules): Promise<BookingRow> {
  if (!ACTIVE_STATUSES.includes(row.status)) return row;
  const { sales, specialist } = await bookingMailboxes(db, rules, row);
  const linked = await findLinkedEvents(calendar, db, rules, row);
  const ids = new Set(row.blockerEventIds ?? []);
  const company = row.companyName ?? 'Erstgespräch';
  const wanted = [
    { kind: 'before', start: new Date(row.startAt.getTime() - rules.bufferBeforeMinutes * 60_000), end: row.startAt, label: 'Vorbereitung' },
    { kind: 'after', start: row.endAt, end: new Date(row.endAt.getTime() + rules.bufferAfterMinutes * 60_000), label: 'Nachbereitung' },
  ];
  for (const mailbox of [...new Set([sales, specialist].map(lower))]) {
    for (const w of wanted) {
      const exists = linked.some(
        (l) => l.role === 'blocker' && lower(l.event.mailbox) === mailbox && new Date(l.event.start).getTime() === w.start.getTime(),
      );
      if (exists) continue;
      const ev = await calendar.createEvent({
        mailbox,
        subject: `Blocker ${w.label}: ${company}`,
        body: `Puffer für das Erstgespräch ${row.bookingRef} (Sales-Portal).`,
        start: w.start.toISOString(),
        end: w.end.toISOString(),
        showAs: 'busy',
        categories: [rules.outlookCategory],
        extendedProperties: { [PROP_REF]: row.bookingRef, [PROP_ROLE]: 'blocker' },
      });
      ids.add(ev.id);
    }
  }
  for (const l of linked) if (l.role === 'blocker') ids.add(l.event.id);
  const next = [...ids];
  if (next.length === (row.blockerEventIds ?? []).length && next.every((id) => row.blockerEventIds.includes(id))) return row;
  const [updated] = await db.update(bookings).set({ blockerEventIds: next, updatedAt: new Date() }).where(eq(bookings.id, row.id)).returning();
  return updated;
}

/** Removes blockers and briefing entries (cancellation). */
export async function removeLinkedEvents(calendar: Adapters['calendar'], db: Db, rules: BookingRules, row: BookingRow): Promise<number> {
  const linked = await findLinkedEvents(calendar, db, rules, row);
  for (const l of linked) await calendar.deleteEvent(l.event.mailbox, l.event.id);
  return linked.length;
}

/** Moves blockers and briefing entries along with the meeting (old times taken from `row`). */
export async function moveLinkedEvents(calendar: Adapters['calendar'], db: Db, rules: BookingRules, row: BookingRow, newStart: Date, newEnd: Date): Promise<number> {
  const linked = await findLinkedEvents(calendar, db, rules, row);
  for (const l of linked) {
    let start: Date;
    let end: Date;
    if (l.role === 'briefing') {
      start = newStart;
      end = newEnd;
    } else if (new Date(l.event.end).getTime() <= row.startAt.getTime()) {
      start = new Date(newStart.getTime() - rules.bufferBeforeMinutes * 60_000);
      end = newStart;
    } else {
      start = newEnd;
      end = new Date(newEnd.getTime() + rules.bufferAfterMinutes * 60_000);
    }
    await calendar.updateEvent(l.event.mailbox, l.event.id, { start: start.toISOString(), end: end.toISOString() });
  }
  return linked.length;
}

// =====================================================================================================================
// Access, listing, cancel, move, call status after cancellation
// =====================================================================================================================

const has = (auth: RequestAuth, role: RequestAuth['effectiveRoles'][number]) => auth.effectiveRoles.includes(role);

/** Object-level access: admin all · coldcaller own bookings (and all of a lead he works on) · sales own · Nico his. */
export function canSeeBooking(auth: RequestAuth, row: Pick<BookingRow, 'createdBy' | 'salesUserId' | 'specialistUserId'>, viaLead = false): boolean {
  if (has(auth, 'admin')) return true;
  if (has(auth, 'coldcaller') && (viaLead || row.createdBy === auth.user.id)) return true;
  if (has(auth, 'sales') && row.salesUserId === auth.user.id) return true;
  if (has(auth, 'ai_specialist') && row.specialistUserId === auth.user.id) return true;
  return false;
}

/** Changing a booking: admin, or the coldcaller (Markus plans and re-plans for the team). */
export function canChangeBooking(auth: RequestAuth): boolean {
  return has(auth, 'admin') || has(auth, 'coldcaller');
}

export async function listBookings(db: Db, auth: RequestAuth, filter: { leadId?: string; status?: Booking['status'][]; upcoming?: boolean }, now: Date): Promise<Booking[]> {
  const conds = [];
  if (filter.leadId) conds.push(eq(bookings.leadId, filter.leadId));
  if (filter.status?.length) conds.push(inArray(bookings.status, filter.status));
  if (filter.upcoming) conds.push(gt(bookings.endAt, now));
  const rows = await db
    .select()
    .from(bookings)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(bookings.startAt))
    .limit(200);
  return rows.filter((r) => canSeeBooking(auth, r, !!filter.leadId)).map(toBooking);
}

export async function getBookingRow(db: Db, id: string): Promise<BookingRow> {
  const [row] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  if (!row) throw notFound('Termin nicht gefunden');
  return row;
}

export async function getBookingFor(db: Db, auth: RequestAuth, id: string): Promise<BookingRow> {
  const row = await getBookingRow(db, id);
  // Coldcallers may open any booking of a lead (lead context); others only their own.
  if (!canSeeBooking(auth, row, has(auth, 'coldcaller'))) throw notFound('Termin nicht gefunden');
  return row;
}

export async function cancelBookingByUser(deps: SchedulingDeps, auth: RequestAuth, id: string): Promise<Booking> {
  if (!canChangeBooking(auth)) throw forbidden();
  const { db } = deps;
  const rules = await getBookingRules(db);
  const row = await getBookingFor(db, auth, id);
  if (!ACTIVE_STATUSES.includes(row.status)) throw conflict('Dieser Termin ist nicht mehr aktiv', 'booking_inactive');
  const { sales } = await bookingMailboxes(db, rules, row);
  if (row.eventId) await deps.calendar.deleteEvent(sales, row.eventId);
  const removed = await removeLinkedEvents(deps.systemCalendar, db, rules, row);
  const [updated] = await db
    .update(bookings)
    .set({ status: 'cancelled', blockerEventIds: [], briefingEventIds: [], updatedAt: deps.now() })
    .where(eq(bookings.id, row.id))
    .returning();
  // CRM: appointment cancelled (or its draft discarded), kls_buchung «abgesagt» – no lead fields, no approval.
  const crm = await syncCrmAppointment(deps, updated, { kind: 'cancel' }, auth.actor);
  await syncCrmBookingRecord(deps, updated, auth.actor);
  await audit(db, {
    actor: auth.actor,
    action: 'scheduling.booking_cancel',
    entity: 'booking',
    entityId: row.id,
    field: 'status',
    oldValue: row.status,
    newValue: 'cancelled',
    meta: { bookingRef: row.bookingRef, removedLinked: removed, by: 'portal', crmAppointment: crm },
  });
  await deps.briefing?.deleted(row.id);
  return toBooking(updated);
}

/** Free/busy from the events themselves, without this booking's own meeting, blockers and briefing entries. */
async function schedulesWithout(calendar: Adapters['calendar'], mailboxes: string[], from: Date, to: Date, row: BookingRow): Promise<MailboxSchedule[]> {
  const own = new Set([row.eventId, ...(row.blockerEventIds ?? []), ...(row.briefingEventIds ?? [])].filter(Boolean));
  const out: MailboxSchedule[] = [];
  for (const mailbox of mailboxes) {
    try {
      const events = await calendar.listEvents(mailbox, from.toISOString(), to.toISOString());
      out.push({
        email: mailbox,
        busy: events
          .filter((e) => !e.isCancelled && !own.has(e.id) && e.extendedProperties?.[PROP_REF] !== row.bookingRef && (!row.iCalUId || e.iCalUId !== row.iCalUId))
          .map((e) => ({ start: e.start, end: e.end, status: e.showAs })),
        error: null,
      });
    } catch {
      out.push({ email: mailbox, busy: [], error: 'Kalender nicht lesbar' });
    }
  }
  return out;
}

export async function moveBookingByUser(deps: SchedulingDeps, auth: RequestAuth, id: string, newStartIso: string): Promise<Booking> {
  if (!canChangeBooking(auth)) throw forbidden();
  const { db } = deps;
  const rules = await getBookingRules(db);
  const row = await getBookingFor(db, auth, id);
  if (!ACTIVE_STATUSES.includes(row.status)) throw conflict('Dieser Termin ist nicht mehr aktiv', 'booking_inactive');
  const start = new Date(newStartIso);
  assertStartAllowed(rules, start, deps.now());
  const end = new Date(start.getTime() + rules.durationMinutes * 60_000);
  if (start.getTime() === row.startAt.getTime()) return toBooking(row);
  const from = new Date(start.getTime() - rules.bufferBeforeMinutes * 60_000);
  const to = new Date(end.getTime() + rules.bufferAfterMinutes * 60_000);

  // Same lock as booking: the check and the move must not interleave with another booking or move.
  const updated = await withBookingLock(deps, async () => {
    const schedules = await schedulesWithout(deps.systemCalendar, scheduleMailboxes(rules, row.extraCall), from, to, row);
    const p = participantsFor(rules, row.extraCall);
    const own = schedules.filter((s) => p.attendees.some((a) => lower(a) === lower(s.email)));
    if (own.length !== p.attendees.length || !isSlotFree({ start: start.toISOString(), end: end.toISOString() }, own, rules)) {
      throw conflict('Dieser Termin ist inzwischen belegt – bitte einen anderen wählen', 'slot_taken');
    }
    // Zusatzcall (Nico + Lukas) only while Manuel cannot – also at the new time (INTENT 6.6).
    if (p.onlyWhenUnavailable && isMailboxFree(schedules, p.onlyWhenUnavailable, from, to)) {
      throw conflict('Zusatzcall nur, wenn Manuel zu dieser Zeit nicht kann – bitte absagen und ohne Zusatzcall neu buchen', 'extra_call_not_allowed');
    }
    const internalIds = [row.salesUserId, row.specialistUserId].filter((x): x is string => !!x);
    if ((await overlappingBookings(db, rules, internalIds, start, end, row.id)).length > 0) {
      throw conflict('Dieser Termin ist inzwischen belegt – bitte einen anderen wählen', 'slot_taken');
    }
    const { sales } = await bookingMailboxes(db, rules, row);
    if (row.eventId) await deps.calendar.updateEvent(sales, row.eventId, { start: start.toISOString(), end: end.toISOString() });
    const [moved] = await db
      .update(bookings)
      .set({ startAt: start, endAt: end, status: 'rescheduled', updatedAt: deps.now() })
      .where(eq(bookings.id, row.id))
      .returning();
    return moved;
  });
  await moveLinkedEvents(deps.systemCalendar, db, rules, row, start, end);
  // CRM: appointment time (or its draft) and kls_buchung «verschoben» follow the meeting.
  const crm = await syncCrmAppointment(deps, updated, { kind: 'move', start, end, previousStart: row.startAt }, auth.actor);
  await syncCrmBookingRecord(deps, updated, auth.actor);
  await audit(db, {
    actor: auth.actor,
    action: 'scheduling.booking_move',
    entity: 'booking',
    entityId: row.id,
    field: 'start',
    oldValue: row.startAt.toISOString(),
    newValue: start.toISOString(),
    meta: { bookingRef: row.bookingRef, by: 'portal', crmAppointment: crm },
  });
  await deps.briefing?.updated(row.id);
  return toBooking(updated);
}

/** After a cancellation Markus sets the call status himself → change set for the approval preview. */
export async function callStatusAfterCancellation(deps: SchedulingDeps, auth: RequestAuth, id: string, callStatus: number): Promise<{ changeSetId: string }> {
  if (!canChangeBooking(auth)) throw forbidden();
  const row = await getBookingFor(deps.db, auth, id);
  if (row.status !== 'cancelled') throw conflict('Den Anrufstatus erst nach einer Absage anpassen', 'booking_not_cancelled');
  const lead = await loadLead(deps.adapters, row.leadId);
  const draft = buildCallStatusChangeSet(lead, callStatus);
  const changeSetId = await insertChangeSet(deps.db, draft, auth.user.id);
  await audit(deps.db, {
    actor: auth.actor,
    action: 'scheduling.cancellation_changeset',
    entity: 'booking',
    entityId: row.id,
    changeSetId,
    meta: { leadId: row.leadId, callStatus },
  });
  return { changeSetId };
}

// =====================================================================================================================
// Booking context for the panel
// =====================================================================================================================

export interface BookingContext {
  lead: {
    leadid: string;
    companyname: string;
    fullname: string | null;
    jobtitle: string | null;
    email: string | null;
    domain: string | null;
    origin: Booking['origin'];
    phone: string | null;
  };
  rules: BookingRules;
  participants: { standard: ParticipantInfo; extraCall: ParticipantInfo };
  subject: string;
  /** Invitation text with person placeholders filled; {Datum} {Uhrzeit} {Sales} {Spezialist} are filled per slot. */
  invitationTemplate: string;
  internalDomains: string[];
  bookings: Booking[];
  calendarMode: 'mock' | 'live';
}

export async function bookingContext(deps: SchedulingDeps, auth: RequestAuth, leadId: string): Promise<BookingContext> {
  const { db } = deps;
  const rules = await getBookingRules(db);
  const lead = await loadLead(deps.adapters, leadId);
  const [subjectTpl, invitation, standard, extraCall, list] = await Promise.all([
    getTemplate(db, 'booking.subject'),
    getTemplate(db, 'booking.invitation'),
    participantInfo(db, rules, false),
    participantInfo(db, rules, true),
    listBookings(db, auth, { leadId }, deps.now()),
  ]);
  const subject = bookingSubject(subjectTpl?.body || rules.subjectTemplate, lead.companyname);
  const invitationTemplate = fillTemplate(invitation?.body ?? '', {
    ...personPlaceholders(lead),
    Absender: auth.user.displayName,
  });
  return {
    lead: {
      leadid: lead.leadid,
      companyname: lead.companyname,
      fullname: lead.fullname || [lead.firstname, lead.lastname].filter(Boolean).join(' ') || null,
      jobtitle: lead.jobtitle,
      email: lead.emailaddress1,
      domain: lead.domain,
      origin: originOf(lead),
      phone: lead.primaryPhone?.display ?? null,
    },
    rules,
    participants: { standard, extraCall },
    subject,
    invitationTemplate,
    internalDomains: internalDomains(rules),
    bookings: list,
    calendarMode: deps.calendar.mode,
  };
}

export type { BookingRow };
