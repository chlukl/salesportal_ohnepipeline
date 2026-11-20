/**
 * Coldcall review fixes (mock CRM, in-memory PGlite):
 *  - AI analysis drafts cannot be pushed / rebuilt / discarded through the generic change-set routes
 *  - a change set is pushed once even when the push is fired twice (atomic claim); «Nicht erreicht» twice → one phone call
 *  - conflict decisions travel with the pushed object to the adapter (live adapter re-checks the snapshot)
 *  - admin setting `campaign.lockMonths` drives the campaign lock
 *  - «Termin gebucht» needs an active booking
 *  - «Rückgängig» of a call result reopens the call (result can be chosen again)
 *  - locked leads (campaign, Divendo …) cannot be called; admins may override with a reason (audited)
 */
import { CALL_STATUS, RESULT_GROUP_CODES, STATUS, type ApplyResult, type ChangeSet, type Lead } from '@sales-portal/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestAuth } from '../src/auth/rbac';
import { auditLog, bookings, callSessions, changeSets, mockCrmActivities, mockCrmLeads, settings } from '../src/db/schema';
import { DEMO_USERS, demoUser } from '../src/db/seed/users';
import type { CrmAdapter } from '../src/integrations/crm/types';
import { pushChangeSet } from '../src/modules/changesets/service';
import { createTestApp, type Session, type TestApp } from './helpers';

let t: TestApp;
let markus: Session;
const used = new Set<string>();

beforeAll(async () => {
  t = await createTestApp({ demoCrm: true });
  markus = await t.login('markus');
});
afterAll(async () => {
  await t?.close();
});

const get = (url: string, s: Session = markus) => t.app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });
const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload: unknown = {}, s: Session = markus) =>
  t.app.inject({ method, url, headers: { ...s.headers, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });

function authFor(key: 'lukas' | 'markus'): RequestAuth {
  const u = DEMO_USERS.find((x) => x.key === key)!;
  return {
    sessionIdHash: 'test',
    csrfToken: 'test',
    user: { id: u.id, email: u.email, displayName: u.displayName, crmUserId: u.crmUserId },
    roles: u.roles,
    effectiveRoles: u.roles,
    viewAs: null,
    isRealAdmin: u.roles.includes('admin'),
    actor: { kind: 'user', userId: u.id, displayName: u.displayName, crmUserId: u.crmUserId, email: u.email },
  };
}

async function freshLead(filter: (l: Lead) => boolean = () => true): Promise<Lead> {
  const crm = t.ctx.adapters.system().crm;
  const page = await crm.listLeads({ requirePhone: true, hideRetryPending: true, statusCodes: [STATUS.NEW], pageSize: 200 });
  const lead = page.items.find((l) => !used.has(l.leadid) && !l.donotphone && filter(l));
  if (!lead) throw new Error('no fresh lead left');
  used.add(lead.leadid);
  return lead;
}

async function startCall(leadId: string, s: Session = markus) {
  const res = await send('POST', '/api/calls', { leadId }, s);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().call as { id: string; status: string };
}

async function endedCall(leadId: string) {
  const call = await startCall(leadId);
  expect((await send('POST', `/api/calls/${call.id}/connected`)).statusCode).toBe(200);
  await send('PUT', `/api/calls/${call.id}/note`, { note: 'Gespräch mit der Geschäftsleitung' });
  expect((await send('POST', `/api/calls/${call.id}/hangup`)).statusCode).toBe(200);
  return call;
}

async function draft(leadId: string, callSessionId: string, ruleKey: string, input: Record<string, unknown> = {}) {
  const res = await send('POST', '/api/changesets', { leadId, callSessionId, ruleKey, input });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { changeSet: ChangeSet | null; issues: { field: string; message: string }[] };
}

async function phoneCalls(leadId: string, code: number) {
  return t.ctx.db
    .select()
    .from(mockCrmActivities)
    .where(and(eq(mockCrmActivities.regardingLeadId, leadId), eq(mockCrmActivities.activitytype, 'phonecall'), eq(mockCrmActivities.kls_anrufergebnis, code)));
}

async function addBooking(leadId: string, callSessionId: string | null, status: 'booked' | 'cancelled' = 'booked') {
  const start = new Date(Date.now() + 7 * 86_400_000);
  const [row] = await t.ctx.db
    .insert(bookings)
    .values({
      bookingRef: `test-${leadId}-${Math.random().toString(36).slice(2)}`,
      leadId,
      callSessionId,
      startAt: start,
      endAt: new Date(start.getTime() + 3_600_000),
      status,
      subject: 'Vorstellung',
      createdBy: demoUser('markus').id,
    })
    .returning();
  return row;
}

describe('AI analysis drafts only through their own approval', () => {
  it('generic push / discard / rebuild of an analysis draft is refused, nothing is written', async () => {
    const lead = await freshLead();
    const [row] = await t.ctx.db
      .insert(changeSets)
      .values({
        leadId: lead.leadid,
        kind: 'analysis',
        ruleVersion: 1,
        operations: [{ id: 'op-mail', entity: 'lead', entityId: lead.leadid, field: 'emailaddress1', label: 'E-Mail', oldValue: lead.emailaddress1, newValue: 'evil@example.com', mode: 'set' }],
        leadCreates: [],
        status: 'draft',
        createdBy: demoUser('markus').id,
      })
      .returning();

    const push = await send('POST', `/api/changesets/${row.id}/push`, {});
    expect(push.statusCode).toBe(409);
    expect(push.json().error.code).toBe('analysis_own_flow');
    expect((await send('POST', `/api/changesets/${row.id}/discard`)).statusCode).toBe(409);
    const call = await endedCall(lead.leadid);
    const rebuild = await send('POST', '/api/changesets', { leadId: lead.leadid, callSessionId: call.id, ruleKey: 'waiting', input: {}, changeSetId: row.id });
    expect(rebuild.statusCode).toBe(409);

    const [after] = await t.ctx.db.select().from(changeSets).where(eq(changeSets.id, row.id));
    expect(after.status).toBe('draft');
    expect(after.kind).toBe('analysis');
    const [leadRow] = await t.ctx.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, lead.leadid));
    expect(leadRow.emailaddress1).toBe(lead.emailaddress1);
    await send('POST', `/api/calls/${call.id}/abandon`).catch(() => undefined);
  });

  it('booking / proposal drafts cannot be rebuilt into a call result either', async () => {
    const lead = await freshLead();
    const [row] = await t.ctx.db
      .insert(changeSets)
      .values({ leadId: lead.leadid, kind: 'booking', ruleKey: 'meeting_booked', ruleVersion: 1, status: 'draft', createdBy: demoUser('markus').id })
      .returning();
    const call = await endedCall(lead.leadid);
    const res = await send('POST', '/api/changesets', { leadId: lead.leadid, callSessionId: call.id, ruleKey: 'waiting', input: {}, changeSetId: row.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('changeset_kind');
  });
});

describe('push runs once', () => {
  it('two concurrent pushes of the same draft → one pushed, one 409, one phone call', async () => {
    const lead = await freshLead();
    const call = await endedCall(lead.leadid);
    const d = await draft(lead.leadid, call.id, 'waiting', { interest: 2 });
    const [a, b] = await Promise.all([send('POST', `/api/changesets/${d.changeSet!.id}/push`, {}), send('POST', `/api/changesets/${d.changeSet!.id}/push`, {})]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect((await phoneCalls(lead.leadid, RESULT_GROUP_CODES.waiting)).length).toBe(1);
    // A rebuild while/after the push does not create a second draft for the same call.
    const again = await send('POST', '/api/changesets', { leadId: lead.leadid, callSessionId: call.id, ruleKey: 'waiting', input: {} });
    expect(again.statusCode).toBe(409);
  });

  it('a claimed («pending») change set is neither pushed again nor rebuilt', async () => {
    const lead = await freshLead();
    const call = await endedCall(lead.leadid);
    const d = await draft(lead.leadid, call.id, 'waiting');
    await t.ctx.db.update(changeSets).set({ status: 'pending', pushedBy: demoUser('markus').id }).where(eq(changeSets.id, d.changeSet!.id));
    const push = await send('POST', `/api/changesets/${d.changeSet!.id}/push`, {});
    expect(push.statusCode).toBe(409);
    expect(push.json().error.code).toBe('push_running');
    const rebuild = await send('POST', '/api/changesets', { leadId: lead.leadid, callSessionId: call.id, ruleKey: 'callback', input: { followUpAt: new Date(Date.now() + 86_400_000).toISOString() } });
    expect(rebuild.statusCode).toBe(409);
    // Fresh, never claimed «pending» rows (e.g. the use-case mail activity) are still pushed.
    const [mail] = await t.ctx.db
      .insert(changeSets)
      .values({
        leadId: lead.leadid,
        kind: 'mail',
        status: 'pending',
        activities: [{ id: 'mail-activity', action: 'create', type: 'email', leadId: lead.leadid, subject: 'Use Cases', text: 'Hallo', direction: 'outgoing', start: new Date().toISOString() }],
        createdBy: demoUser('markus').id,
      })
      .returning();
    const mailPush = await send('POST', `/api/changesets/${mail.id}/push`, {});
    expect(mailPush.statusCode, mailPush.body).toBe(200);
    expect(mailPush.json().status).toBe('pushed');
  });

  it('«Nicht erreicht» twice (double click / key repeat) → one phone call', async () => {
    const lead = await freshLead();
    const call = await startCall(lead.leadid);
    const [a, b] = await Promise.all([send('POST', `/api/calls/${call.id}/not-reached`), send('POST', `/api/calls/${call.id}/not-reached`)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect((await phoneCalls(lead.leadid, RESULT_GROUP_CODES.not_reached)).length).toBe(1);
    const [session] = await t.ctx.db.select().from(callSessions).where(eq(callSessions.id, call.id));
    expect(session.status).toBe('not_reached');
  });
});

describe('conflict decisions reach the adapter', () => {
  it('«Überschreiben» is part of the pushed change set (first push succeeds)', async () => {
    const lead = await freshLead();
    const call = await endedCall(lead.leadid);
    const d = await draft(lead.leadid, call.id, 'waiting');
    await t.ctx.db.update(mockCrmLeads).set({ kls_callstatus: CALL_STATUS.CALLBACK_TOMORROW }).where(eq(mockCrmLeads.leadid, lead.leadid));
    const first = (await send('POST', `/api/changesets/${d.changeSet!.id}/push`, {})).json();
    expect(first.status).toBe('conflict');
    const c = first.changeSet.conflicts.find((x: { field: string }) => x.field === 'kls_callstatus');
    expect(c).toBeTruthy();

    // Spy adapter: what does the adapter get? (The live adapter skips its snapshot check only for resolved conflicts.)
    const base = t.ctx.adapters.system().crm;
    const seen: ChangeSet[] = [];
    const spy = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'applyChangeSet') {
          return async (cs: ChangeSet, actor: Parameters<CrmAdapter['applyChangeSet']>[1]): Promise<ApplyResult> => {
            seen.push(cs);
            return target.applyChangeSet(cs, actor);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as CrmAdapter;
    const res = await pushChangeSet({ db: t.ctx.db, crm: spy, auth: authFor('markus'), now: () => new Date() }, d.changeSet!.id, { [c.opId]: 'overwrite' });
    expect(res.status).toBe('pushed');
    expect(seen).toHaveLength(1);
    expect(seen[0].conflicts.find((x) => x.opId === c.opId)?.resolution).toBe('overwrite');
    const [row] = await t.ctx.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, lead.leadid));
    expect(row.kls_callstatus).toBe(CALL_STATUS.WAITING);
  });
});

describe('campaign lock follows the admin setting', () => {
  it('campaign.lockMonths = 120 locks a campaign lead that is free after 3 months', async () => {
    const crm = t.ctx.adapters.system().crm;
    const all = await crm.listLeads({ campaign: 'all', includeHidden: true, pageSize: 200 });
    const free = all.items.find((l) => l.campaign.inCampaign && !l.campaign.locked);
    expect(free, 'demo data has an unlocked campaign lead').toBeTruthy();
    await t.ctx.db.insert(settings).values({ key: 'campaign.lockMonths', value: 120 }).onConflictDoUpdate({ target: settings.key, set: { value: 120 } });
    try {
      const locked = (await crm.getLead(free!.leadid))!;
      expect(locked.campaign.locked).toBe(true);
      expect(Date.parse(locked.campaign.lockedUntil!)).toBeGreaterThan(Date.parse(free!.campaign.lockedUntil ?? '1970-01-01'));
    } finally {
      await t.ctx.db.delete(settings).where(eq(settings.key, 'campaign.lockMonths'));
    }
    expect((await crm.getLead(free!.leadid))!.campaign.locked).toBe(false);
  });
});

describe('«Termin gebucht» comes with the booking', () => {
  it('without an active booking there is no draft; the push re-checks', async () => {
    const lead = await freshLead();
    const call = await endedCall(lead.leadid);
    const none = await draft(lead.leadid, call.id, 'meeting_booked', { decisionMakerInMeeting: true });
    expect(none.changeSet).toBeNull();
    expect(none.issues[0]).toMatchObject({ field: 'booking' });
    await addBooking(lead.leadid, null, 'cancelled');
    expect((await draft(lead.leadid, call.id, 'meeting_booked')).issues[0]?.field).toBe('booking');

    const booking = await addBooking(lead.leadid, call.id);
    const ok = await draft(lead.leadid, call.id, 'meeting_booked', { decisionMakerInMeeting: true });
    expect(ok.issues).toEqual([]);
    expect(ok.changeSet).not.toBeNull();

    // Booking cancelled before the approval → the push is refused, nothing written.
    await t.ctx.db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, booking.id));
    const push = await send('POST', `/api/changesets/${ok.changeSet!.id}/push`, {});
    expect(push.statusCode).toBe(409);
    expect(push.json().error.code).toBe('booking_missing');
    expect((await phoneCalls(lead.leadid, RESULT_GROUP_CODES.meeting_booked)).length).toBe(0);

    await t.ctx.db.update(bookings).set({ status: 'rescheduled' }).where(eq(bookings.id, booking.id));
    expect((await send('POST', `/api/changesets/${ok.changeSet!.id}/push`, {})).json().status).toBe('pushed');
  });
});

describe('«Rückgängig» of a call result', () => {
  it('cancels the phone call and reopens the call, so the result can be recorded again', async () => {
    const lead = await freshLead();
    const call = await endedCall(lead.leadid);
    const d = await draft(lead.leadid, call.id, 'no_need');
    expect((await send('POST', `/api/changesets/${d.changeSet!.id}/push`, {})).json().status).toBe('pushed');
    const revert = await send('POST', `/api/changesets/${d.changeSet!.id}/revert`, {});
    expect(revert.statusCode, revert.body).toBe(200);

    const [session] = await t.ctx.db.select().from(callSessions).where(eq(callSessions.id, call.id));
    expect(session).toMatchObject({ status: 'ended', changeSetId: null, crmPhonecallId: null, resultGroup: null });
    const unfinished = (await get('/api/calls?scope=unfinished')).json().items as { id: string }[];
    expect(unfinished.some((c) => c.id === call.id)).toBe(true);

    const again = await draft(lead.leadid, call.id, 'waiting');
    expect(again.changeSet).not.toBeNull();
    expect((await send('POST', `/api/changesets/${again.changeSet!.id}/push`, {})).json().status).toBe('pushed');
    const active = (await phoneCalls(lead.leadid, RESULT_GROUP_CODES.waiting)).filter((p) => p.statecode !== 2);
    expect(active).toHaveLength(1);
    const cancelled = (await phoneCalls(lead.leadid, RESULT_GROUP_CODES.no_need)).filter((p) => p.statecode === 2);
    expect(cancelled).toHaveLength(1);
  });
});

describe('locked leads are not called', () => {
  it('coldcaller gets 422 with the reasons; admin override needs a reason and is audited', async () => {
    const crm = t.ctx.adapters.system().crm;
    const all = await crm.listLeads({ includeHidden: true, campaign: 'all', requirePhone: true, pageSize: 200 });
    const locked = all.items.find((l) => !l.donotphone && l.kls_callstatus !== CALL_STATUS.DO_NOT_CONTACT && (l.campaign.locked || l.exclusions.some((e) => e !== 'do_not_contact')));
    expect(locked, 'demo data has a locked lead').toBeTruthy();
    const res = await send('POST', '/api/calls', { leadId: locked!.leadid });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('lead_locked');
    expect((await send('POST', '/api/calls', { leadId: locked!.leadid, override: { reason: 'Kunde hat angerufen' } })).statusCode).toBe(403);

    const lukas = await t.login('lukas');
    const ok = await send('POST', '/api/calls', { leadId: locked!.leadid, override: { reason: 'Kunde bittet um Rückruf' } }, lukas);
    expect(ok.statusCode, ok.body).toBe(200);
    const audits = await t.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'call.locked_override'), eq(auditLog.entityId, locked!.leadid)));
    expect(audits).toHaveLength(1);
    await send('POST', `/api/calls/${ok.json().call.id}/abandon`, {}, lukas);
  });
});

describe('Tagesziel', () => {
  it('counts own calls and conversations of today, not other people’s, not aborted ones', async () => {
    const before = (await get('/api/calls/today')).json() as { calls: number; conversations: number; notReached: number };
    const lead = await freshLead();
    await endedCall(lead.leadid);
    const other = await freshLead();
    const aborted = await startCall(other.leadid);
    await send('POST', `/api/calls/${aborted.id}/abandon`);
    const after = (await get('/api/calls/today')).json() as typeof before;
    expect(after.calls).toBe(before.calls + 1);
    expect(after.conversations).toBe(before.conversations + 1);
    const lukas = await t.login('lukas');
    const own = (await get('/api/calls/today', lukas)).json() as typeof before;
    expect(own.calls).toBeLessThan(after.calls);
    expect((await get('/api/calls/today', await t.login('manuel'))).statusCode).toBe(403);
  });
});
