/** Scheduling module: slots, booking with blockers + change set, double-booking guard, proposals, delta watcher, RBAC. */
import {
  addDaysIso,
  CALL_STATUS,
  isAllowedStart,
  isoWeek,
  isSlotFree,
  localIsoDate,
  mondayOfIso,
  type Booking,
  type Lead,
  type Slot,
} from '@sales-portal/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, bookings, changeSets, mockCalendarEvents, mockOutbox, notifications, syncState } from '../src/db/schema';
import { DEMO_EMAILS, demoUser } from '../src/db/seed/users';
import { MockCalendarAdapter } from '../src/integrations/calendar/mock';
import { createLogger } from '../src/lib/logger';
import type { JobContext } from '../src/jobs/registry';
import { createTestApp, type Session, type TestApp } from './helpers';

let t: TestApp;
let markus: Session;
let leads: Lead[];

beforeAll(async () => {
  t = await createTestApp({ demoCrm: true });
  markus = await t.login('markus');
  const page = await t.ctx.adapters.system().crm.listLeads({ requireEmail: true, pageSize: 50 });
  leads = page.items.filter((l) => l.emailaddress1 && l.domain);
  expect(leads.length).toBeGreaterThan(10);
});
afterAll(async () => {
  await t?.close();
});

const nextMonday = () => mondayOfIso(addDaysIso(localIsoDate(new Date()), 7));

async function getSlots(s: Session, from: string, extraCall = false, days = 5): Promise<{ slots: Slot[]; participants: { sales: { email: string } } }> {
  const res = await t.app.inject({ method: 'GET', url: `/api/scheduling/slots?from=${from}&days=${days}&extraCall=${extraCall}`, headers: { cookie: s.cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

function bookingPayload(lead: Lead, start: string, extra: Record<string, unknown> = {}) {
  return {
    leadId: lead.leadid,
    start,
    extraCall: false,
    subject: `Vorstellung der Kallysoft Informatik AG als KI-Spezialist – ${lead.companyname}`,
    body: 'Guten Tag',
    attendees: [{ email: lead.emailaddress1!, name: lead.fullname, isMainContact: true }],
    needsPreparation: false,
    decisionMakerInMeeting: true,
    ...extra,
  };
}

async function book(lead: Lead, weekOffset = 0, extra: Record<string, unknown> = {}): Promise<{ booking: Booking; changeSetId: string }> {
  const { slots } = await getSlots(markus, addDaysIso(nextMonday(), 7 * weekOffset));
  expect(slots.length).toBeGreaterThan(0);
  const res = await t.app.inject({ method: 'POST', url: '/api/scheduling/bookings', headers: markus.headers, payload: bookingPayload(lead, slots[0].start, extra) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

function jobCtx(): JobContext {
  return {
    config: t.ctx.config,
    db: t.ctx.db,
    adapters: t.ctx.adapters.system(),
    log: createLogger('silent'),
    job: { id: 0, type: 'recurring:scheduling.calendar_delta', attempts: 1, maxAttempts: 1 },
    enqueue: async () => undefined,
    now: () => new Date(),
  };
}

async function runDelta(): Promise<void> {
  const job = t.ctx.jobs.get('recurring:scheduling.calendar_delta');
  expect(job).toBeTruthy();
  await job!.handler({}, jobCtx());
}

const calendar = () => t.ctx.adapters.system().calendar as MockCalendarAdapter;

async function linkedEvents(bookingRef: string) {
  const rows = await t.ctx.db.select().from(mockCalendarEvents);
  return rows.filter((r) => r.extendedProperties?.KlsTerminId === bookingRef && r.extendedProperties?.KlsRolle && !r.deletedAt);
}

describe('roles', () => {
  it('only coldcaller and admin search slots and book', async () => {
    const nico = await t.login('nico');
    const manuel = await t.login('manuel');
    const from = nextMonday();
    expect((await t.app.inject({ method: 'GET', url: `/api/scheduling/slots?from=${from}`, headers: { cookie: nico.cookie } })).statusCode).toBe(403);
    const res = await t.app.inject({ method: 'POST', url: '/api/scheduling/bookings', headers: manuel.headers, payload: bookingPayload(leads[0], new Date().toISOString()) });
    expect(res.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: `/api/scheduling/slots?from=${from}` })).statusCode).toBe(401);
  });

  it('validates input (zod)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/scheduling/slots?from=morgen', headers: { cookie: markus.cookie } });
    expect(res.statusCode).toBe(400);
    const bad = await t.app.inject({ method: 'POST', url: '/api/scheduling/bookings', headers: markus.headers, payload: { leadId: leads[0].leadid } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('slots and context', () => {
  it('context: participants, subject from the template, invitation text', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/scheduling/context/${leads[0].leadid}`, headers: { cookie: markus.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const ctx = res.json();
    expect(ctx.participants.standard.sales.email).toBe(DEMO_EMAILS.manuel);
    expect(ctx.participants.standard.specialist.email).toBe(DEMO_EMAILS.nico);
    expect(ctx.participants.extraCall.sales.email).toBe(DEMO_EMAILS.lukas);
    expect(ctx.subject).toBe(`Vorstellung der Kallysoft Informatik AG als KI-Spezialist – ${leads[0].companyname}`);
    expect(ctx.invitationTemplate).toContain('{Datum}');
    expect(ctx.invitationTemplate).not.toContain('{Absender}');
  });

  it('every offered slot is allowed and free for Manuel and Nico incl. buffers', async () => {
    const { slots, participants } = await getSlots(markus, nextMonday(), false, 10);
    expect(participants.sales.email).toBe(DEMO_EMAILS.manuel);
    expect(slots.length).toBeGreaterThan(5);
    const rules = (await t.app.inject({ method: 'GET', url: '/api/scheduling/rules', headers: { cookie: markus.cookie } })).json();
    for (const s of slots) {
      expect(isAllowedStart(s.start, rules)).toBe(true);
      const schedules = await calendar().getSchedule([DEMO_EMAILS.manuel, DEMO_EMAILS.nico], new Date(new Date(s.start).getTime() - 3_600_000).toISOString(), new Date(new Date(s.end).getTime() + 3_600_000).toISOString());
      expect(isSlotFree(s, schedules, rules)).toBe(true);
    }
  });

  it('Zusatzcall slots only where Manuel cannot', async () => {
    const from = nextMonday();
    const standard = new Set((await getSlots(markus, from, false, 10)).slots.map((s) => s.start));
    const extra = await getSlots(markus, from, true, 10);
    expect(extra.participants.sales.email).toBe(DEMO_EMAILS.lukas);
    for (const s of extra.slots) expect(standard.has(s.start)).toBe(false);
  });
});

describe('booking', () => {
  it('creates the Teams meeting, blockers, the booking row and a change set «Termin gebucht»', async () => {
    const lead = leads[0];
    const { booking, changeSetId } = await book(lead);
    expect(booking.status).toBe('booked');
    expect(booking.bookingRef).toMatch(/^KLS-\d{8}-[A-Z0-9]{6}$/);
    expect(booking.externalAttendees).toEqual([expect.objectContaining({ email: lead.emailaddress1, isMainContact: true })]);
    expect(booking.salesUserId).toBe(demoUser('manuel').id);
    expect(booking.specialistUserId).toBe(demoUser('nico').id);
    expect(booking.iCalUId).toBeTruthy();

    // Meeting in Manuel's calendar (organizer), category + Termin-ID, Nico gets a copy.
    const event = await calendar().getEvent(DEMO_EMAILS.manuel, booking.eventId!);
    expect(event).toMatchObject({ organizer: DEMO_EMAILS.manuel, isOnlineMeeting: true, categories: ['Kallysoft Erstgespräch'] });
    expect(event!.extendedProperties.KlsTerminId).toBe(booking.bookingRef);
    expect(event!.attendees.map((a) => a.email)).toEqual(expect.arrayContaining([DEMO_EMAILS.nico, lead.emailaddress1]));
    const copies = (await t.ctx.db.select().from(mockCalendarEvents).where(eq(mockCalendarEvents.iCalUId, booking.iCalUId!))).map((r) => r.mailbox);
    expect(copies.sort()).toEqual([DEMO_EMAILS.manuel, DEMO_EMAILS.nico].sort());

    // Blockers 30 min before / after in the calendars of Manuel and Nico, linked by Termin-ID.
    const blockers = await linkedEvents(booking.bookingRef);
    expect(blockers).toHaveLength(4);
    expect(booking.blockerEventIds.sort()).toEqual(blockers.map((b) => b.id).sort());
    const start = new Date(booking.start).getTime();
    for (const b of blockers) {
      expect([start - 30 * 60_000, start + 30 * 60_000]).toContain(b.startAt.getTime());
      expect(b.endAt.getTime() - b.startAt.getTime()).toBe(30 * 60_000);
    }

    // Change set for the approval preview (nothing pushed yet).
    const [cs] = await t.ctx.db.select().from(changeSets).where(eq(changeSets.id, changeSetId));
    expect(cs.status).toBe('draft');
    expect(cs.kind).toBe('booking');
    expect(cs.ruleKey).toBe('meeting_booked');
    expect(cs.createdBy).toBe(demoUser('markus').id);
    const ops = Object.fromEntries(cs.operations.map((o) => [o.field, o.newValue]));
    if (lead.kls_callstatus !== CALL_STATUS.MEETING_BOOKED) expect(ops.kls_callstatus).toBe(CALL_STATUS.MEETING_BOOKED);
    if (!lead.kls_interests.includes(845140014)) expect(ops.kls_interests).toContain(845140014);
    if (lead.decisionmaker !== true) expect(ops.decisionmaker).toBe(true);
    expect(cs.activities).toEqual([expect.objectContaining({ type: 'appointment' })]);

    const audits = await t.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'scheduling.booking_create'), eq(auditLog.entityId, booking.id)));
    expect(audits).toHaveLength(1);
  });

  it('double-booking guard: the same slot again → «belegt»', async () => {
    const { slots } = await getSlots(markus, addDaysIso(nextMonday(), 21));
    const first = await t.app.inject({ method: 'POST', url: '/api/scheduling/bookings', headers: markus.headers, payload: bookingPayload(leads[1], slots[0].start) });
    expect(first.statusCode, first.body).toBe(201);
    const second = await t.app.inject({ method: 'POST', url: '/api/scheduling/bookings', headers: markus.headers, payload: bookingPayload(leads[2], slots[0].start) });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('slot_taken');
  });

  it('rejects starts outside the windows and in the past', async () => {
    const day = addDaysIso(nextMonday(), 1);
    const lunch = new Date(`${day}T11:30:00Z`).toISOString(); // 12:30 Zurich
    const res = await t.app.inject({ method: 'POST', url: '/api/scheduling/bookings', headers: markus.headers, payload: bookingPayload(leads[3], lunch) });
    expect(res.statusCode).toBe(422);
    const past = await t.app.inject({ method: 'POST', url: '/api/scheduling/bookings', headers: markus.headers, payload: bookingPayload(leads[3], '2020-01-07T09:00:00.000Z') });
    expect(past.statusCode).toBe(422);
  });

  it('validates attendees (format, typos, internal addresses)', async () => {
    const { slots } = await getSlots(markus, addDaysIso(nextMonday(), 28));
    for (const bad of ['keine-adresse', 'x@gmial.com', `${'nico.demo'}@example.ch`]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/scheduling/bookings',
        headers: markus.headers,
        payload: bookingPayload(leads[3], slots[0].start, { attendees: [{ email: bad, isMainContact: true }] }),
      });
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it('Zusatzcall only when Manuel cannot', async () => {
    const { slots } = await getSlots(markus, addDaysIso(nextMonday(), 28));
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/scheduling/bookings',
      headers: markus.headers,
      payload: bookingPayload(leads[3], slots[0].start, { extraCall: true }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('extra_call_not_allowed');
    const extra = await getSlots(markus, addDaysIso(nextMonday(), 28), true);
    if (extra.slots.length) {
      const ok = await t.app.inject({ method: 'POST', url: '/api/scheduling/bookings', headers: markus.headers, payload: bookingPayload(leads[3], extra.slots[0].start, { extraCall: true }) });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(ok.json().booking.salesUserId).toBe(demoUser('lukas').id);
    }
  });
});

describe('delta watcher (INTENT 6.11)', () => {
  it('moved in Outlook → blockers move along, booking «verschoben», Markus + sales informed', async () => {
    const { booking } = await book(leads[4], 1);
    await runDelta(); // initial sync: nothing changes
    const [unchanged] = await t.ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(unchanged.status).toBe('booked');

    const newStart = new Date(new Date(booking.start).getTime() + 2 * 86_400_000).toISOString();
    await calendar().simulateMove(DEMO_EMAILS.manuel, booking.eventId!, newStart);
    await runDelta();
    const [row] = await t.ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row.status).toBe('rescheduled');
    expect(row.startAt.toISOString()).toBe(newStart);
    const blockers = await linkedEvents(booking.bookingRef);
    expect(blockers).toHaveLength(4);
    const s = new Date(newStart).getTime();
    for (const b of blockers) expect([s - 30 * 60_000, s + 30 * 60_000]).toContain(b.startAt.getTime());
    const notes = await t.ctx.db.select().from(notifications).where(and(eq(notifications.entityId, booking.id), eq(notifications.kind, 'booking_rescheduled')));
    expect(notes.map((n) => n.userId).sort()).toEqual([demoUser('markus').id, demoUser('manuel').id].sort());
    const tokens = await t.ctx.db.select().from(syncState);
    expect(tokens.some((r) => r.key === `calendar.delta:${DEMO_EMAILS.manuel}`)).toBe(true);
  });

  it('another external person declines → hint, meeting stays', async () => {
    const lead = leads[5];
    const { booking } = await book(lead, 2, {
      attendees: [
        { email: lead.emailaddress1!, isMainContact: true },
        { email: `zweite.person@${lead.domain}`, name: 'Zweite Person' },
      ],
    });
    await calendar().simulateResponse(DEMO_EMAILS.manuel, booking.eventId!, `zweite.person@${lead.domain}`, 'declined');
    await runDelta();
    const [row] = await t.ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row.status).toBe('booked');
    expect(row.externalAttendees.find((a) => !a.isMainContact)!.response).toBe('declined');
    const hints = await t.ctx.db.select().from(notifications).where(and(eq(notifications.entityId, booking.id), eq(notifications.kind, 'attendee_declined')));
    expect(hints.length).toBe(2); // Markus + sales
    expect(await linkedEvents(booking.bookingRef)).toHaveLength(4);
  });

  it('Nico declines → warning «neu planen» once, meeting and blockers stay', async () => {
    const { booking } = await book(leads[6], 3);
    await calendar().simulateResponse(DEMO_EMAILS.manuel, booking.eventId!, DEMO_EMAILS.nico, 'declined');
    await runDelta();
    await calendar().updateEvent(DEMO_EMAILS.manuel, booking.eventId!, { body: 'Agenda ergänzt' }); // another change
    await runDelta();
    const warnings = await t.ctx.db.select().from(notifications).where(and(eq(notifications.entityId, booking.id), eq(notifications.kind, 'internal_declined')));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].userId).toBe(demoUser('markus').id);
    expect(warnings[0].severity).toBe('warning');
    const [row] = await t.ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row.status).toBe('booked');
    expect(await linkedEvents(booking.bookingRef)).toHaveLength(4);
  });

  it('main contact declines → Absage: Markus informed, blockers + briefing entry removed, call status only after click', async () => {
    const lead = leads[7];
    const { booking } = await book(lead, 4);
    // A briefing entry the ai module would create (linked by Termin-ID).
    const briefing = await calendar().createEvent({
      mailbox: DEMO_EMAILS.nico,
      subject: `Briefing: ${lead.companyname}`,
      start: booking.start,
      end: booking.end,
      showAs: 'free',
      categories: ['Kallysoft Briefing'],
      extendedProperties: { KlsTerminId: booking.bookingRef, KlsRolle: 'briefing' },
    });
    await t.ctx.db.update(bookings).set({ briefingEventIds: [briefing.id] }).where(eq(bookings.id, booking.id));
    const before = (await t.ctx.adapters.system().crm.getLead(lead.leadid))!;

    await calendar().simulateResponse(DEMO_EMAILS.manuel, booking.eventId!, lead.emailaddress1!, 'declined');
    await runDelta();
    const [row] = await t.ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row.status).toBe('cancelled');
    expect(await linkedEvents(booking.bookingRef)).toHaveLength(0);
    expect(await calendar().getEvent(DEMO_EMAILS.nico, briefing.id)).toBeNull();
    const [note] = await t.ctx.db.select().from(notifications).where(and(eq(notifications.entityId, booking.id), eq(notifications.kind, 'booking_cancelled')));
    expect(note.userId).toBe(demoUser('markus').id);
    expect(note.link).toBe(`/lead/${lead.leadid}`);
    expect(note.body).toContain(lead.companyname);
    // No CRM change without Markus' click.
    const after = (await t.ctx.adapters.system().crm.getLead(lead.leadid))!;
    expect(after.kls_callstatus).toBe(before.kls_callstatus);

    const cs = await t.app.inject({ method: 'POST', url: `/api/scheduling/bookings/${booking.id}/callstatus`, headers: markus.headers, payload: { callStatus: CALL_STATUS.CALLBACK_7_DAYS } });
    expect(cs.statusCode, cs.body).toBe(200);
    const [draft] = await t.ctx.db.select().from(changeSets).where(eq(changeSets.id, cs.json().changeSetId));
    expect(draft.status).toBe('draft');
  });

  it('deleted by the organizer → Absage', async () => {
    const { booking } = await book(leads[8], 5);
    await calendar().simulateCancel(DEMO_EMAILS.manuel, booking.eventId!);
    await runDelta();
    const [row] = await t.ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row.status).toBe('cancelled');
    expect(await linkedEvents(booking.bookingRef)).toHaveLength(0);
    const copies = await t.ctx.db.select().from(mockCalendarEvents).where(eq(mockCalendarEvents.iCalUId, booking.iCalUId!));
    expect(copies.find((c) => c.mailbox === DEMO_EMAILS.nico)!.isCancelled).toBe(true);
  });

  it('call status change is refused while the booking is active', async () => {
    const { booking } = await book(leads[9], 6);
    const res = await t.app.inject({ method: 'POST', url: `/api/scheduling/bookings/${booking.id}/callstatus`, headers: markus.headers, payload: { callStatus: CALL_STATUS.CALLBACK_7_DAYS } });
    expect(res.statusCode).toBe(409);
  });

  it('portal move and cancel keep blockers consistent', async () => {
    const { booking } = await book(leads[10], 7);
    const { slots } = await getSlots(markus, addDaysIso(nextMonday(), 7 * 7 + 1));
    const moved = await t.app.inject({ method: 'POST', url: `/api/scheduling/bookings/${booking.id}/move`, headers: markus.headers, payload: { start: slots[0].start } });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().status).toBe('rescheduled');
    const s = new Date(slots[0].start).getTime();
    for (const b of await linkedEvents(booking.bookingRef)) expect([s - 30 * 60_000, s + 30 * 60_000]).toContain(b.startAt.getTime());
    await runDelta(); // the watcher sees the move as already applied
    const notes = await t.ctx.db.select().from(notifications).where(and(eq(notifications.entityId, booking.id), eq(notifications.kind, 'booking_rescheduled')));
    expect(notes).toHaveLength(0);
    const cancelled = await t.app.inject({ method: 'POST', url: `/api/scheduling/bookings/${booking.id}/cancel`, headers: markus.headers });
    expect(cancelled.statusCode).toBe(200);
    expect(await linkedEvents(booking.bookingRef)).toHaveLength(0);
  });
});

describe('booking visibility (object level)', () => {
  it('sales sees only own bookings, Nico his, admin all', async () => {
    const manuel = await t.login('manuel');
    const nico = await t.login('nico');
    const lukas = await t.login('lukas');
    const own = (await t.app.inject({ method: 'GET', url: '/api/scheduling/bookings', headers: { cookie: manuel.cookie } })).json().items as Booking[];
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((b) => b.salesUserId === demoUser('manuel').id)).toBe(true);
    const nicos = (await t.app.inject({ method: 'GET', url: '/api/scheduling/bookings', headers: { cookie: nico.cookie } })).json().items as Booking[];
    expect(nicos.every((b) => b.specialistUserId === demoUser('nico').id)).toBe(true);
    const all = (await t.app.inject({ method: 'GET', url: '/api/scheduling/bookings', headers: { cookie: lukas.cookie } })).json().items as Booking[];
    expect(all.length).toBeGreaterThan(own.length);
    const lukasBooking = all.find((b) => b.salesUserId === demoUser('lukas').id);
    if (lukasBooking) {
      const res = await t.app.inject({ method: 'GET', url: `/api/scheduling/bookings/${lukasBooking.id}`, headers: { cookie: manuel.cookie } });
      expect(res.statusCode).toBe(404);
    }
  });

  it('demo simulation is admin-only', async () => {
    const [any] = await t.ctx.db.select().from(bookings).where(eq(bookings.status, 'booked')).limit(1);
    const res = await t.app.inject({ method: 'POST', url: `/api/scheduling/bookings/${any.id}/simulate`, headers: markus.headers, payload: { action: 'cancel' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('3 Vorschläge', () => {
  it('months: current + 3, preselection', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/scheduling/proposals/months', headers: { cookie: markus.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().months).toHaveLength(4);
  });

  it('proposes up to 3 slots in different weeks, drafts the mail, swaps one, sends, creates the change set', async () => {
    const lead = leads[11];
    const months = (await t.app.inject({ method: 'GET', url: '/api/scheduling/proposals/months', headers: { cookie: markus.cookie } })).json();
    const month = months.months[1];
    const res = await t.app.inject({ method: 'POST', url: '/api/scheduling/proposals', headers: markus.headers, payload: { leadId: lead.leadid, month, preference: 'any' } });
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json();
    expect(result.proposals).toHaveLength(3);
    const weeks = result.proposals.map((p: { slot: Slot }) => JSON.stringify(isoWeek(localIsoDate(p.slot.start))));
    expect(new Set(weeks).size).toBe(3);
    expect(result.draft.to).toEqual([lead.emailaddress1]);
    expect(result.draft.subject).toContain(lead.companyname);
    expect(result.draft.body).toContain(result.text);
    expect(result.draft.body).not.toContain('{Vorschlaege}');

    const swap = await t.app.inject({
      method: 'POST',
      url: '/api/scheduling/proposals/swap',
      headers: markus.headers,
      payload: { leadId: lead.leadid, month, preference: 'any', current: result.proposals.map((p: { slot: Slot }) => ({ start: p.slot.start, end: p.slot.end })), index: 1 },
    });
    expect(swap.statusCode, swap.body).toBe(200);
    const swapped = swap.json().proposals.map((p: { slot: Slot }) => p.slot.start);
    expect(swapped).not.toContain(result.proposals[1].slot.start);
    expect(swapped).toContain(result.proposals[0].slot.start);

    const outboxBefore = (await t.ctx.db.select().from(mockOutbox)).length;
    const sent = await t.app.inject({
      method: 'POST',
      url: '/api/scheduling/proposals/send',
      headers: markus.headers,
      payload: { leadId: lead.leadid, to: result.draft.to, subject: result.draft.subject, body: swap.json().draft.body },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    expect((await t.ctx.db.select().from(mockOutbox)).length).toBe(outboxBefore + 1);
    const [cs] = await t.ctx.db.select().from(changeSets).where(eq(changeSets.id, sent.json().changeSetId));
    expect(cs.status).toBe('draft');
    expect(cs.ruleKey).toBe('proposals_sent');
    if (lead.kls_callstatus !== CALL_STATUS.MEETING_PROPOSED) {
      expect(cs.operations.find((o) => o.field === 'kls_callstatus')?.newValue).toBe(CALL_STATUS.MEETING_PROPOSED);
    }
    expect(cs.activities).toEqual([expect.objectContaining({ type: 'email', to: [lead.emailaddress1] })]);
    // follow-up task after 3 working days (or an adapted existing one per REGEL_AUFGABEN)
    if (cs.tasks.length) expect(cs.tasks[0].leadId).toBe(lead.leadid);
  });

  it('refuses months outside the selection and invalid recipients', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/scheduling/proposals', headers: markus.headers, payload: { leadId: leads[0].leadid, month: '2031-01-01' } });
    expect(res.statusCode).toBe(422);
    const sent = await t.app.inject({
      method: 'POST',
      url: '/api/scheduling/proposals/send',
      headers: markus.headers,
      payload: { leadId: leads[0].leadid, to: ['anna@muster.con'], subject: 'x', body: 'y' },
    });
    expect(sent.statusCode).toBe(400);
  });
});
