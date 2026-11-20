/**
 * Cross-module contracts (integration): calls ↔ scheduling ↔ changesets ↔ ai ↔ pendenzen.
 *  - a booking made during a call does not finish or end the call; the call result «Termin gebucht» is still recorded
 *  - during a call the booking change set holds only the appointment: lead fields come once, with the call result
 *  - booking hooks the ai briefing (job queued); cancelling removes it again
 *  - pendenzen do not list analysis drafts as «Freigabe»
 */
import { addDaysIso, localIsoDate, mondayOfIso, type Lead, type Slot } from '@sales-portal/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, callSessions, changeSets, jobs } from '../src/db/schema';
import { demoUser } from '../src/db/seed/users';
import { createTestApp, type Session, type TestApp } from './helpers';

let t: TestApp;
let markus: Session;
let leads: Lead[];

beforeAll(async () => {
  t = await createTestApp({ demoCrm: true });
  markus = await t.login('markus');
  const page = await t.ctx.adapters.system().crm.listLeads({ requireEmail: true, pageSize: 50 });
  leads = page.items.filter((l) => l.emailaddress1 && l.primaryPhone && !l.donotphone && !l.campaign.locked);
  expect(leads.length).toBeGreaterThan(3);
});
afterAll(async () => {
  await t?.close();
});

async function post(url: string, payload: unknown = {}) {
  const res = await t.app.inject({ method: 'POST', url, headers: markus.headers, payload: payload as Record<string, unknown> });
  return { status: res.statusCode, body: res.json() };
}

async function firstSlot(): Promise<Slot> {
  const from = mondayOfIso(addDaysIso(localIsoDate(new Date()), 7));
  const res = await t.app.inject({ method: 'GET', url: `/api/scheduling/slots?from=${from}&days=5`, headers: { cookie: markus.cookie } });
  expect(res.statusCode, res.body).toBe(200);
  const { slots } = res.json() as { slots: Slot[] };
  expect(slots.length).toBeGreaterThan(0);
  return slots[0];
}

describe('booking during a call', () => {
  it('keeps the call open, then the call result adds only the phone call', async () => {
    const lead = leads[0];
    const start = await post('/api/calls', { leadId: lead.leadid });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const callId: string = start.body.call.id;
    expect((await post(`/api/calls/${callId}/connected`)).status).toBe(200);

    const slot = await firstSlot();
    const booked = await post('/api/scheduling/bookings', {
      leadId: lead.leadid,
      callSessionId: callId,
      start: slot.start,
      extraCall: false,
      subject: `Vorstellung – ${lead.companyname}`,
      body: 'Guten Tag',
      attendees: [{ email: lead.emailaddress1, name: lead.fullname, isMainContact: true }],
      needsPreparation: false,
      decisionMakerInMeeting: true,
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.withCallResult).toBe(true);
    const [bookingCs] = await t.ctx.db.select().from(changeSets).where(eq(changeSets.id, booked.body.changeSetId));
    expect(bookingCs.operations).toEqual([]);
    expect(bookingCs.tasks).toEqual([]);
    expect(bookingCs.activities.map((a) => a.type)).toEqual(['appointment']);

    // Briefing hook: the ai module's build job is queued for this booking.
    const briefingJobs = await t.ctx.db.select().from(jobs).where(eq(jobs.dedupeKey, `ai.build_briefing:${booked.body.booking.id}`));
    expect(briefingJobs.length).toBe(1);

    // Approving the booking change set mid-call neither ends nor completes the call.
    const pushBooking = await post(`/api/changesets/${booked.body.changeSetId}/push`);
    expect(pushBooking.body.status).toBe('pushed');
    const [callAfterBooking] = await t.ctx.db.select().from(callSessions).where(eq(callSessions.id, callId));
    expect(callAfterBooking.status).toBe('connected');
    expect(callAfterBooking.changeSetId).toBeNull();

    // Call result «Termin gebucht»: the lead fields are written here, once (the booking wrote only the appointment).
    expect((await post(`/api/calls/${callId}/hangup`)).status).toBe(200);
    const draft = await post('/api/changesets', { leadId: lead.leadid, callSessionId: callId, ruleKey: 'meeting_booked', input: { decisionMakerInMeeting: true } });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const pushed = await post(`/api/changesets/${draft.body.changeSet.id}/push`);
    expect(pushed.body.status).toBe('pushed');
    const bookingFieldAudits = await t.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.changeSetId, booked.body.changeSetId), eq(auditLog.action, 'crm.field_update')));
    expect(bookingFieldAudits).toHaveLength(0);
    const resultFieldAudits = await t.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.changeSetId, draft.body.changeSet.id), eq(auditLog.action, 'crm.field_update')));
    expect(resultFieldAudits.length).toBeGreaterThan(0);
    expect(new Set(resultFieldAudits.map((a) => a.field)).size).toBe(resultFieldAudits.length);
    const [callDone] = await t.ctx.db.select().from(callSessions).where(eq(callSessions.id, callId));
    expect(callDone.status).toBe('completed');
    expect(callDone.crmPhonecallId).toBeTruthy();
  });

  it('a field already set in the CRM is skipped at push time (booking approved after the call result)', async () => {
    const lead = leads[1];
    const start = await post('/api/calls', { leadId: lead.leadid });
    const callId: string = start.body.call.id;
    await post(`/api/calls/${callId}/connected`);
    const slot = await firstSlot();
    const booked = await post('/api/scheduling/bookings', {
      leadId: lead.leadid,
      callSessionId: callId,
      start: slot.start,
      extraCall: false,
      subject: `Vorstellung – ${lead.companyname}`,
      body: 'Guten Tag',
      attendees: [{ email: lead.emailaddress1, name: lead.fullname, isMainContact: true }],
      needsPreparation: false,
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    await post(`/api/calls/${callId}/hangup`);
    const draft = await post('/api/changesets', { leadId: lead.leadid, callSessionId: callId, ruleKey: 'meeting_booked', input: {} });
    expect((await post(`/api/changesets/${draft.body.changeSet.id}/push`)).body.status).toBe('pushed');
    // Now the booking change set: it carries only the appointment activity.
    const pushBooking = await post(`/api/changesets/${booked.body.changeSetId}/push`);
    expect(pushBooking.body.status).toBe('pushed');
    const fieldAudits = await t.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.changeSetId, booked.body.changeSetId), eq(auditLog.action, 'crm.field_update')));
    expect(fieldAudits).toHaveLength(0);
    const [call] = await t.ctx.db.select().from(callSessions).where(eq(callSessions.id, callId));
    expect(call.status).toBe('completed');
    expect(call.changeSetId).toBe(draft.body.changeSet.id);
  });
});

describe('pendenzen ↔ ai', () => {
  it('does not list analysis drafts as «Freigabe»', async () => {
    const lead = leads[2];
    const [row] = await t.ctx.db
      .insert(changeSets)
      .values({
        leadId: lead.leadid,
        kind: 'analysis',
        ruleVersion: 1,
        operations: [],
        activities: [],
        tasks: [],
        notes: [],
        stateChanges: [],
        leadCreates: [],
        baseSnapshot: {},
        status: 'draft',
        conflicts: [],
        results: [],
        createdBy: demoUser('markus').id,
      })
      .returning();
    const res = await t.app.inject({ method: 'GET', url: '/api/pendenzen', headers: { cookie: markus.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json() as { items: { id: string }[] }).items;
    expect(items.some((i) => i.id === `approval:${row.id}`)).toBe(false);
  });
});
