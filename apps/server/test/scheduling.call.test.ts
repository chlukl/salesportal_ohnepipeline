/**
 * Scheduling fixes:
 *  - booking / proposals during a call: the change set holds only the activity, fields + follow-up task come once with
 *    the call result (no second follow-up task, one preview for the fields)
 *  - callSessionId is checked (own call, same lead)
 *  - double-booking guard serialized (concurrent requests for the same slot → exactly one booking)
 *  - Zusatzcall rule also when moving
 *  - CRM appointment follows cancellations and moves; drafts of cancelled bookings are discarded; kls_buchung writes
 */
import { addDaysIso, isSlotFree, localIsoDate, mondayOfIso, type Booking, type BookingRules, type Lead, type Slot } from '@sales-portal/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditLog, bookings, changeSets, mockCrmActivities } from '../src/db/schema';
import { DEMO_EMAILS } from '../src/db/seed/users';
import type { MockCalendarAdapter } from '../src/integrations/calendar/mock';
import type { JobContext } from '../src/jobs/registry';
import { createLogger } from '../src/lib/logger';
import { syncCrmBookingRecord, SYNC_BOOKING_JOB, SYSTEM_ACTOR } from '../src/modules/scheduling/crmSync';
import { withBookingLock, type SchedulingDeps } from '../src/modules/scheduling/util';
import { createTestApp, type Session, type TestApp } from './helpers';

let t: TestApp;
let markus: Session;
let leads: Lead[];
let rules: BookingRules;

beforeAll(async () => {
  t = await createTestApp({ demoCrm: true });
  markus = await t.login('markus');
  const page = await t.ctx.adapters.system().crm.listLeads({ requireEmail: true, pageSize: 80 });
  leads = page.items.filter((l) => l.emailaddress1 && l.domain && l.primaryPhone && !l.donotphone && !l.campaign.locked);
  expect(leads.length).toBeGreaterThan(8);
  rules = (await t.app.inject({ method: 'GET', url: '/api/scheduling/rules', headers: { cookie: markus.cookie } })).json();
});
afterAll(async () => {
  await t?.close();
});

const calendar = () => t.ctx.adapters.system().calendar as MockCalendarAdapter;
const week = (offset: number) => addDaysIso(mondayOfIso(addDaysIso(localIsoDate(new Date()), 7)), 7 * offset);

async function post(url: string, payload: unknown = {}, s: Session = markus) {
  const res = await t.app.inject({ method: 'POST', url, headers: s.headers, payload: payload as Record<string, unknown> });
  return { status: res.statusCode, body: res.json() };
}

async function slots(from: string, extraCall = false, days = 5): Promise<Slot[]> {
  const res = await t.app.inject({ method: 'GET', url: `/api/scheduling/slots?from=${from}&days=${days}&extraCall=${extraCall}`, headers: { cookie: markus.cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().slots;
}

/** First free slot from week `offset` on – the demo seed has full vacation weeks relative to today. */
async function firstFreeSlot(offset: number): Promise<Slot> {
  for (let w = offset; w < offset + 4; w++) {
    const [s] = await slots(week(w));
    if (s) return s;
  }
  throw new Error(`no free slot in weeks ${offset}–${offset + 3}`);
}

function payload(lead: Lead, start: string, extra: Record<string, unknown> = {}) {
  return {
    leadId: lead.leadid,
    start,
    extraCall: false,
    subject: `Vorstellung – ${lead.companyname}`,
    body: 'Guten Tag',
    attendees: [{ email: lead.emailaddress1!, name: lead.fullname, isMainContact: true }],
    needsPreparation: false,
    ...extra,
  };
}

async function startCall(lead: Lead): Promise<string> {
  const res = await post('/api/calls', { leadId: lead.leadid });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect((await post(`/api/calls/${res.body.call.id}/connected`)).status).toBe(200);
  return res.body.call.id;
}

async function changeSet(id: string) {
  const [row] = await t.ctx.db.select().from(changeSets).where(eq(changeSets.id, id));
  return row;
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
  await t.ctx.jobs.get('recurring:scheduling.calendar_delta')!.handler({}, jobCtx());
}

async function appointmentOf(changeSetId: string) {
  const cs = await changeSet(changeSetId);
  const op = cs.activities.find((a) => a.type === 'appointment')!;
  const created = cs.results.find((r) => r.opId === op.id)?.createdId;
  expect(created).toBeTruthy();
  const [row] = await t.ctx.db.select().from(mockCrmActivities).where(eq(mockCrmActivities.activityid, created!));
  return row;
}

describe('during a call: one follow-up task, fields only with the call result', () => {
  it('«3 Vorschläge» in a call: the mail change set has no task and no fields; the call result proposes the one task', async () => {
    const lead = leads[0];
    const callId = await startCall(lead);
    const months = (await t.app.inject({ method: 'GET', url: '/api/scheduling/proposals/months', headers: { cookie: markus.cookie } })).json();
    const proposals = await post('/api/scheduling/proposals', { leadId: lead.leadid, month: months.months[1], preference: 'any' });
    expect(proposals.status, JSON.stringify(proposals.body)).toBe(200);
    const sent = await post('/api/scheduling/proposals/send', {
      leadId: lead.leadid,
      callSessionId: callId,
      to: [lead.emailaddress1],
      subject: proposals.body.draft.subject,
      body: proposals.body.draft.body,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.withCallResult).toBe(true);
    const mailCs = await changeSet(sent.body.changeSetId);
    expect(mailCs.tasks).toEqual([]);
    expect(mailCs.operations).toEqual([]);
    expect(mailCs.stateChanges).toEqual([]);
    expect(mailCs.activities.map((a) => a.type)).toEqual(['email']);

    // Call result «3 Vorschläge gesendet» (preselected in the workspace) carries call status + the follow-up task.
    expect((await post(`/api/calls/${callId}/hangup`)).status).toBe(200);
    const draft = await post('/api/changesets', { leadId: lead.leadid, callSessionId: callId, ruleKey: 'proposals_sent', input: {} });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const followUps = (draft.body.changeSet.tasks as { action: string }[]).filter((x) => x.action === 'create' || x.action === 'update');
    expect(followUps.length).toBeLessThanOrEqual(1);

    expect((await post(`/api/changesets/${sent.body.changeSetId}/push`)).body.status).toBe('pushed');
    expect((await post(`/api/changesets/${draft.body.changeSet.id}/push`)).body.status).toBe('pushed');
    const taskCreates = await t.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'crm.task_create'), inArray(auditLog.changeSetId, [sent.body.changeSetId, draft.body.changeSet.id])));
    expect(taskCreates.length).toBeLessThanOrEqual(1);
    const fromMail = taskCreates.filter((a) => a.changeSetId === sent.body.changeSetId);
    expect(fromMail).toHaveLength(0);
  });

  it('outside a call the proposals change set keeps fields and the follow-up task', async () => {
    const lead = leads[1];
    const months = (await t.app.inject({ method: 'GET', url: '/api/scheduling/proposals/months', headers: { cookie: markus.cookie } })).json();
    const proposals = await post('/api/scheduling/proposals', { leadId: lead.leadid, month: months.months[1], preference: 'any' });
    const sent = await post('/api/scheduling/proposals/send', { leadId: lead.leadid, to: [lead.emailaddress1], subject: proposals.body.draft.subject, body: proposals.body.draft.body });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.withCallResult).toBe(false);
    const cs = await changeSet(sent.body.changeSetId);
    expect(cs.tasks.length).toBe(1);
  });

  it('callSessionId must be an own call of the same lead', async () => {
    const s = await firstFreeSlot(2);
    const unknown = await post('/api/scheduling/bookings', payload(leads[2], s.start, { callSessionId: '00000000-0000-4000-8000-000000000999' }));
    expect(unknown.status).toBe(404);
    const callId = await startCall(leads[2]);
    const otherLead = await post('/api/scheduling/bookings', payload(leads[3], s.start, { callSessionId: callId }));
    expect(otherLead.status).toBe(400);
    const sendOther = await post('/api/scheduling/proposals/send', { leadId: leads[3].leadid, callSessionId: callId, to: [leads[3].emailaddress1], subject: 'x', body: 'y' });
    expect(sendOther.status).toBe(400);
    // Nothing was booked for the refused requests.
    const rows = await t.ctx.db.select().from(bookings).where(inArray(bookings.leadId, [leads[2].leadid, leads[3].leadid]));
    expect(rows).toHaveLength(0);
  });
});

describe('double-booking guard is serialized', () => {
  it('two concurrent bookings of the same slot → exactly one wins', async () => {
    const [s] = await slots(week(3));
    const [a, b] = await Promise.all([
      post('/api/scheduling/bookings', payload(leads[4], s.start)),
      post('/api/scheduling/bookings', payload(leads[5], s.start)),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('slot_taken');
    const active = await t.ctx.db.select().from(bookings).where(and(eq(bookings.startAt, new Date(s.start)), inArray(bookings.status, ['booked', 'rescheduled'])));
    expect(active).toHaveLength(1);
  });

  it('withBookingLock never interleaves two critical sections', async () => {
    const log: string[] = [];
    const section = (name: string) => async () => {
      log.push(`${name}:in`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`${name}:out`);
    };
    await Promise.all([withBookingLock({}, section('a')), withBookingLock({}, section('b')), withBookingLock({}, section('c'))]);
    expect(log).toEqual(['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out']);
    // A failing section does not block the next one.
    await expect(withBookingLock({}, async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await withBookingLock({}, async () => 42)).toBe(42);
  });
});

describe('Zusatzcall when moving', () => {
  it('refuses to move a Zusatzcall to a time where Manuel is free', async () => {
    const from = week(5);
    const standard = await slots(from, false, 5);
    const lukasFree = async (s: Slot) => {
      const sched = await calendar().getSchedule([DEMO_EMAILS.lukas], new Date(new Date(s.start).getTime() - 3_600_000).toISOString(), new Date(new Date(s.end).getTime() + 3_600_000).toISOString());
      return isSlotFree(s, sched, rules);
    };
    const candidates: Slot[] = [];
    for (const s of standard) if (await lukasFree(s)) candidates.push(s);
    // Two candidates far enough apart that blocking Manuel for the first leaves the second free.
    const first = candidates[0];
    const second = candidates.find((c) => Math.abs(new Date(c.start).getTime() - new Date(first.start).getTime()) >= 4 * 3_600_000);
    expect(first && second).toBeTruthy();
    // Manuel cannot at the first time → the Zusatzcall is allowed there.
    await calendar().createEvent({ mailbox: DEMO_EMAILS.manuel, subject: 'Kundentermin', start: first.start, end: first.end, showAs: 'busy' });
    const booked = await post('/api/scheduling/bookings', payload(leads[6], first.start, { extraCall: true }));
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.booking.extraCall).toBe(true);

    const moved = await post(`/api/scheduling/bookings/${booked.body.booking.id}/move`, { start: second!.start });
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe('extra_call_not_allowed');
    const [row] = await t.ctx.db.select().from(bookings).where(eq(bookings.id, booked.body.booking.id));
    expect(row.startAt.toISOString()).toBe(new Date(first.start).toISOString());
  });
});

describe('CRM appointment follows the booking', () => {
  it('portal cancel after approval → CRM appointment cancelled (statecode 2)', async () => {
    const [s] = await slots(week(6));
    const booked = await post('/api/scheduling/bookings', payload(leads[7], s.start));
    expect(booked.status).toBe(201);
    expect((await post(`/api/changesets/${booked.body.changeSetId}/push`)).body.status).toBe('pushed');
    expect((await appointmentOf(booked.body.changeSetId)).statecode).not.toBe(2);
    const cancelled = await post(`/api/scheduling/bookings/${booked.body.booking.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect((await appointmentOf(booked.body.changeSetId)).statecode).toBe(2);
    const audits = await t.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'crm.activity_update'), eq(auditLog.changeSetId, booked.body.changeSetId)));
    expect(audits).toHaveLength(1);
  });

  it('cancellation detected in Outlook → CRM appointment cancelled by the watcher', async () => {
    const [s] = await slots(week(7));
    const booked = await post('/api/scheduling/bookings', payload(leads[8], s.start));
    await post(`/api/changesets/${booked.body.changeSetId}/push`);
    await runDelta(); // initial sync of the organizer calendar
    await calendar().simulateCancel(DEMO_EMAILS.manuel, (booked.body.booking as Booking).eventId!);
    await runDelta();
    expect((await appointmentOf(booked.body.changeSetId)).statecode).toBe(2);
  });

  it('cancelled before approval → the booking draft is discarded (no «Termin vereinbart» later)', async () => {
    const [s] = await slots(week(8));
    const booked = await post('/api/scheduling/bookings', payload(leads[0], s.start));
    expect(booked.status).toBe(201);
    await post(`/api/scheduling/bookings/${booked.body.booking.id}/cancel`);
    expect((await changeSet(booked.body.changeSetId)).status).toBe('discarded');
  });

  it('moved before approval → the draft appointment gets the new time; after approval the CRM is updated', async () => {
    const list = await slots(week(9), false, 5);
    const booked = await post('/api/scheduling/bookings', payload(leads[1], list[0].start));
    expect(booked.status).toBe(201);
    const target = list.find((x) => Math.abs(new Date(x.start).getTime() - new Date(list[0].start).getTime()) >= 4 * 3_600_000)!;
    const moved = await post(`/api/scheduling/bookings/${booked.body.booking.id}/move`, { start: target.start });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const draft = await changeSet(booked.body.changeSetId);
    expect(draft.status).toBe('draft');
    expect(draft.activities.find((a) => a.type === 'appointment')!.start).toBe(new Date(target.start).toISOString());

    // Approved → moved again in Outlook → the watcher updates the CRM appointment time.
    expect((await post(`/api/changesets/${booked.body.changeSetId}/push`)).body.status).toBe('pushed');
    const later = new Date(new Date(target.start).getTime() + 86_400_000).toISOString();
    await runDelta(); // the portal move is already applied – nothing to do
    await calendar().simulateMove(DEMO_EMAILS.manuel, (booked.body.booking as Booking).eventId!, later);
    await runDelta();
    const [audit] = await t.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'crm.activity_update'), eq(auditLog.changeSetId, booked.body.changeSetId)));
    expect(audit).toMatchObject({ field: 'scheduledstart', newValue: later });
  });
});

describe('kls_buchung', () => {
  it('writes the booking record when the CRM supports it, stores the id, retries on failure', async () => {
    const [row] = await t.ctx.db.select().from(bookings).limit(1);
    const system = t.ctx.adapters.system();
    const upsertBooking = vi.fn(async (b: Booking) => {
      expect(b.bookingRef).toBe(row.bookingRef);
      return 'b0000000-0000-4000-8000-000000000001';
    });
    const enqueue = vi.fn(async () => undefined);
    const deps: SchedulingDeps = {
      db: t.ctx.db,
      adapters: { ...system, crm: Object.assign(Object.create(system.crm), { upsertBooking }) },
      calendar: system.calendar,
      systemCalendar: system.calendar,
      log: createLogger('silent'),
      now: () => new Date(),
      enqueue,
    };
    expect(await syncCrmBookingRecord(deps, row, SYSTEM_ACTOR)).toBe(true);
    expect(upsertBooking).toHaveBeenCalledWith(expect.objectContaining({ status: row.status, origin: row.origin }), row.crmBookingId, SYSTEM_ACTOR);
    const [stored] = await t.ctx.db.select().from(bookings).where(eq(bookings.id, row.id));
    expect(stored.crmBookingId).toBe('b0000000-0000-4000-8000-000000000001');

    upsertBooking.mockRejectedValueOnce(new Error('CRM nicht erreichbar'));
    expect(await syncCrmBookingRecord(deps, stored, SYSTEM_ACTOR)).toBe(false);
    expect(enqueue).toHaveBeenCalledWith(SYNC_BOOKING_JOB, { bookingId: row.id }, { dedupeKey: `crm-booking:${row.id}` });

    // Mock CRM without kls_buchung: nothing to do.
    expect(await syncCrmBookingRecord({ ...deps, adapters: system }, stored, SYSTEM_ACTOR)).toBe(false);
  });
});
