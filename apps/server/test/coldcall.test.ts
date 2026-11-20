/**
 * Coldcall core end to end on the mock CRM: call list defaults, saved filters, call session (dial → connected → hang up →
 * result → push), «Nicht erreicht» + «Rückgängig», conflict check, retry after a partial failure, other contact person,
 * inbound callbacks, RBAC and object-level access.
 */
import { CALL_STATUS, RESULT_GROUP_CODES, STATUS, type ChangeSet, type Lead, type Paged } from '@sales-portal/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyses, auditLog, bookings, callSessions, mockCrmActivities, mockCrmLeads, mockCrmTasks } from '../src/db/schema';
import { demoUser } from '../src/db/seed/users';
import { suggestUseCases } from '../src/modules/workspace/useCases';
import { createTestApp, type Session, type TestApp } from './helpers';

let t: TestApp;
let markus: Session;
const MARKUS_CRM = demoUser('markus').crmUserId;
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

/** A fresh, callable, open «Neu» lead (each test gets its own). */
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
  expect(res.statusCode).toBe(200);
  return res.json().call as { id: string; status: string; reason: string };
}

async function finishCallWith(leadId: string, ruleKey: string, input: Record<string, unknown> = {}) {
  const call = await startCall(leadId);
  expect((await send('POST', `/api/calls/${call.id}/connected`)).statusCode).toBe(200);
  await send('PUT', `/api/calls/${call.id}/note`, { note: 'Kunde will Unterlagen zu Offerten' });
  expect((await send('POST', `/api/calls/${call.id}/hangup`)).statusCode).toBe(200);
  const draft = await send('POST', '/api/changesets', { leadId, callSessionId: call.id, ruleKey, input });
  expect(draft.statusCode).toBe(200);
  return { call, draft: draft.json() as { changeSet: ChangeSet | null; issues: { field: string; message: string }[] } };
}

describe('RBAC and validation', () => {
  it('only coldcaller/admin use the call list, calls and change sets; sales may open the workspace read-only', async () => {
    const manuel = await t.login('manuel');
    expect((await get('/api/leads', manuel)).statusCode).toBe(403);
    expect((await send('POST', '/api/calls', { leadId: 'x' }, manuel)).statusCode).toBe(403);
    expect((await get('/api/changesets', manuel)).statusCode).toBe(403);
    const lead = await freshLead();
    used.delete(lead.leadid);
    const ws = await get(`/api/workspace/${lead.leadid}`, manuel);
    expect(ws.statusCode).toBe(200);
    expect(ws.json().canCall).toBe(false);
    expect((await t.app.inject({ method: 'GET', url: '/api/leads' })).statusCode).toBe(401);
  });

  it('rejects invalid input', async () => {
    expect((await send('POST', '/api/calls', { leadId: 'bad id!' })).statusCode).toBe(400);
    expect((await send('POST', '/api/changesets', { leadId: 'x', ruleKey: 'nope', input: {} })).statusCode).toBe(400);
    expect((await send('POST', '/api/changesets', { leadId: 'x', ruleKey: 'waiting', input: { evil: 1 } })).statusCode).toBe(400);
    expect((await send('PUT', `/api/calls/00000000-0000-4000-8000-000000000999/note`, { note: 'x' })).statusCode).toBe(404);
  });
});

describe('Anrufliste', () => {
  it('defaults: only callable leads with a valid number; explicit false lifts it', async () => {
    const page = (await get('/api/leads?pageSize=200')).json() as Paged<Lead>;
    expect(page.items.length).toBeGreaterThan(0);
    for (const l of page.items) {
      expect(l.primaryPhone).not.toBeNull();
      expect(l.exclusions).toEqual([]);
    }
    const all = (await get('/api/leads?pageSize=200&requirePhone=false')).json() as Paged<Lead>;
    expect(all.total).toBeGreaterThan(page.total);
  });

  it('«nächster Lead» skips the current and already worked leads', async () => {
    const list = (await get('/api/leads?pageSize=3&sort=score')).json() as Paged<Lead>;
    const [a, b, c] = list.items;
    const next = (await get(`/api/leads/next?sort=score&currentLeadId=${a.leadid}`)).json();
    expect(next.lead.leadid).toBe(b.leadid);
    const skip = (await get(`/api/leads/next?sort=score&currentLeadId=${a.leadid}&skip=${b.leadid}`)).json();
    expect(skip.lead.leadid).toBe(c.leadid);
  });

  it('saved filters per person: create, default is exclusive, update, delete; nobody else can touch them', async () => {
    const f1 = await send('POST', '/api/leads/filters', { name: 'A/B 20–249', filter: { grades: ['A', 'B'], employeeBands: ['20-49', '50-249'], excludeIndustries: ['Bau'] }, columns: ['score', 'company'], isDefault: true });
    expect(f1.statusCode).toBe(200);
    const f2 = await send('POST', '/api/leads/filters', { name: 'Rückrufe', filter: { due: 'today' }, isDefault: true });
    const items = (await get('/api/leads/filters')).json().items as { id: string; isDefault: boolean; filter: { grades?: string[] } }[];
    expect(items.filter((i) => i.isDefault).map((i) => i.id)).toEqual([f2.json().id]);
    expect(items.find((i) => i.id === f1.json().id)?.filter.grades).toEqual(['A', 'B']);

    const lukas = await t.login('lukas');
    expect((await send('PUT', `/api/leads/filters/${f1.json().id}`, { name: 'fremd' }, lukas)).statusCode).toBe(404);
    expect((await get('/api/leads/filters', lukas)).json().items).toEqual([]);

    expect((await send('PUT', `/api/leads/filters/${f1.json().id}`, { name: 'A/B neu' })).json().name).toBe('A/B neu');
    expect((await send('DELETE', `/api/leads/filters/${f1.json().id}`)).statusCode).toBe(204);
    expect((await send('POST', '/api/leads/filters', { name: '', filter: {} })).statusCode).toBe(400);
  });
});

describe('call session and result', () => {
  it('dial → connected → note → hang up → «Wartet» → push writes CRM, audit and closes the call', async () => {
    const lead = await freshLead((l) => l.ownerid !== MARKUS_CRM);
    const { call, draft } = await finishCallWith(lead.leadid, 'waiting', { interest: 2 });
    expect(call.reason).toBeTruthy();
    // «Aufgelegt» with Vera on hands the call to the ai module (transcript + analysis later, Markus never waits).
    const pendingAnalyses = await t.ctx.db.select().from(analyses).where(eq(analyses.callSessionId, call.id));
    expect(pendingAnalyses).toHaveLength(1);
    const cs = draft.changeSet!;
    expect(draft.issues).toEqual([]);
    expect(cs.status).toBe('draft');
    expect(cs.ruleVersion).toBe(1);
    expect(cs.operations.map((o) => o.field)).toEqual(expect.arrayContaining(['kls_callstatus', 'ownerid', 'statuscode']));

    // Note changed after the preview → the push carries the newest note.
    await send('PUT', `/api/calls/${call.id}/note`, { note: 'Kunde will Unterlagen zu Offerten. Rückmeldung bis Freitag.' });
    const push = await send('POST', `/api/changesets/${cs.id}/push`, {});
    expect(push.statusCode).toBe(200);
    expect(push.json().status).toBe('pushed');

    const [row] = await t.ctx.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, lead.leadid));
    expect(row.kls_callstatus).toBe(CALL_STATUS.WAITING);
    expect(row.ownerid).toBe(MARKUS_CRM);
    expect(row.statuscode).toBe(STATUS.CONTACTED);
    expect(row.modifiedon.getTime()).toBeGreaterThan(Date.parse(lead.modifiedon));

    const calls = await t.ctx.db.select().from(mockCrmActivities).where(and(eq(mockCrmActivities.regardingLeadId, lead.leadid), eq(mockCrmActivities.kls_anrufergebnis, RESULT_GROUP_CODES.waiting)));
    expect(calls).toHaveLength(1);
    expect(calls[0].description).toBe('Kunde will Unterlagen zu Offerten. Rückmeldung bis Freitag.');
    expect(calls[0].ownerid).toBe(MARKUS_CRM);
    expect(calls[0].kls_interesse).toBe(2);

    const tasks = await t.ctx.db.select().from(mockCrmTasks).where(and(eq(mockCrmTasks.ownerid, MARKUS_CRM), eq(mockCrmTasks.statecode, 0)));
    expect(tasks.some((x) => x.subject === `Nachfassen ${lead.companyname}` || x.regardingLeadId === lead.leadid)).toBe(true);

    const audits = await t.ctx.db.select().from(auditLog).where(eq(auditLog.changeSetId, cs.id));
    const fieldAudit = audits.find((a) => a.action === 'crm.field_update' && a.field === 'kls_callstatus');
    expect(fieldAudit).toMatchObject({ oldValue: lead.kls_callstatus, newValue: CALL_STATUS.WAITING, actorLabel: 'Markus' });
    expect(audits.some((a) => a.action === 'changeset.push')).toBe(true);

    const [session] = await t.ctx.db.select().from(callSessions).where(eq(callSessions.id, call.id));
    expect(session.status).toBe('completed');
    expect(session.resultGroup).toBe('waiting');
    expect(session.crmPhonecallId).toBe(calls[0].activityid);
    expect(session.durationSource).toBe('clicks');
    expect((await send('POST', `/api/changesets/${cs.id}/push`, {})).statusCode).toBe(409);
  });

  it('one running call per person; inbound callbacks start connected', async () => {
    const a = await freshLead();
    const b = await freshLead();
    const call = await startCall(a.leadid);
    expect((await send('POST', '/api/calls', { leadId: a.leadid })).json().resumed).toBe(true);
    const blocked = await send('POST', '/api/calls', { leadId: b.leadid });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('call_active');
    expect((await get('/api/calls/active')).json().call.id).toBe(call.id);
    expect((await send('POST', `/api/calls/${call.id}/hangup`)).statusCode).toBe(409); // still dialing
    expect((await send('POST', `/api/calls/${call.id}/abandon`)).statusCode).toBe(200);

    const inbound = await send('POST', '/api/calls', { leadId: b.leadid, direction: 'inbound', phoneE164: b.primaryPhone!.e164, reason: 'Rückruf auf Anruf vom 18.11.' });
    expect(inbound.statusCode).toBe(200);
    expect(inbound.json().call).toMatchObject({ status: 'connected', direction: 'inbound', category: 'callback_answered', reason: 'Rückruf auf Anruf vom 18.11.' });
    const id = inbound.json().call.id;
    expect((await send('PUT', `/api/calls/${id}/vera`, { enabled: false })).json().veraEnabled).toBe(false);
    await send('POST', `/api/calls/${id}/hangup`);
    expect(await t.ctx.db.select().from(analyses).where(eq(analyses.callSessionId, id))).toHaveLength(0); // Vera off → only the note
    const unfinished = (await get('/api/calls?scope=unfinished')).json().items as { id: string }[];
    expect(unfinished.some((c) => c.id === id)).toBe(true);
    const d = await send('POST', '/api/changesets', { leadId: b.leadid, callSessionId: id, ruleKey: 'callback', input: { followUpAt: new Date(Date.now() + 2 * 86_400_000).toISOString() } });
    const pushed = await send('POST', `/api/changesets/${d.json().changeSet.id}/push`, {});
    expect(pushed.json().status).toBe('pushed');
    const [pc] = await t.ctx.db.select().from(mockCrmActivities).where(and(eq(mockCrmActivities.regardingLeadId, b.leadid), eq(mockCrmActivities.kls_anrufergebnis, RESULT_GROUP_CODES.callback)));
    expect(pc.direction).toBe('incoming');
  });

  it('«Nicht erreicht»: one click saves call + status, hides the lead until the next half-day, «Rückgängig» restores', async () => {
    const lead = await freshLead();
    const call = await startCall(lead.leadid);
    const res = await send('POST', `/api/calls/${call.id}/not-reached`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('pushed');
    expect(body.call.status).toBe('not_reached');
    expect(Date.parse(body.nextAttemptAt)).toBeGreaterThan(Date.now());
    expect(body.attempts).toBeGreaterThanOrEqual(1);

    const crm = t.ctx.adapters.system().crm;
    const after = (await crm.getLead(lead.leadid))!;
    expect(after.kls_callstatus).toBe(CALL_STATUS.NOT_REACHED);
    expect(after.nextAttemptAt).toBe(body.nextAttemptAt);
    expect(after.ownerid).toBe(lead.ownerid); // nobody reached → no owner change
    const hidden = (await get(`/api/leads?pageSize=200&search=${encodeURIComponent(lead.companyname)}`)).json() as Paged<Lead>;
    expect(hidden.items.some((l) => l.leadid === lead.leadid)).toBe(false);

    const undo = await send('POST', `/api/calls/${call.id}/undo-not-reached`);
    expect(undo.statusCode).toBe(200);
    expect(undo.json().call.status).toBe('dialing');
    const restored = (await crm.getLead(lead.leadid))!;
    expect(restored.kls_callstatus).toBe(lead.kls_callstatus);
    expect(restored.nextAttemptAt ?? null).toBeNull();
    const calls = await crm.listPhoneCalls({ leadId: lead.leadid, resultCodes: [RESULT_GROUP_CODES.not_reached] });
    expect(calls.some((c) => c.id === body.changeSet.results.find((r: { kind: string }) => r.kind === 'activity').createdId)).toBe(false);
    await send('POST', `/api/calls/${call.id}/abandon`);
  });

  it('disqualifying needs the reason; then note → fields → status', async () => {
    const lead = await freshLead();
    const { draft } = await finishCallWith(lead.leadid, 'competitor', {});
    expect(draft.changeSet).toBeNull();
    expect(draft.issues[0].field).toBe('reason');
    const again = await send('POST', '/api/changesets', { leadId: lead.leadid, callSessionId: (await get('/api/calls/active')).json().call.id, ruleKey: 'competitor', input: { reason: 'ist selbst IT-Dienstleister' } });
    const cs = again.json().changeSet as ChangeSet;
    expect(cs.notes[0].text).toMatch(/^Sales-Portal: Nicht qualifiziert/);
    expect((await send('POST', `/api/changesets/${cs.id}/push`, {})).json().status).toBe('pushed');
    const [row] = await t.ctx.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, lead.leadid));
    expect(row.statecode).toBe(2);
    expect(row.statuscode).toBe(STATUS.OUTSIDE_ICP);
    expect(row.kls_competitor).toBe(true);
    const notes = await t.ctx.db.select().from(mockCrmActivities).where(and(eq(mockCrmActivities.regardingLeadId, lead.leadid), eq(mockCrmActivities.activitytype, 'note')));
    expect(notes.some((n) => n.description?.startsWith('Sales-Portal: Nicht qualifiziert'))).toBe(true);
  });

  it('conflict check: field changed in the CRM since the draft needs a decision per field', async () => {
    const lead = await freshLead();
    // «Termin gebucht» comes with a booking (scheduling module) – here a booking row is enough.
    const start = new Date(Date.now() + 7 * 86_400_000);
    await t.ctx.db.insert(bookings).values({ bookingRef: `conflict-${lead.leadid}`, leadId: lead.leadid, startAt: start, endAt: new Date(start.getTime() + 3_600_000), subject: 'Vorstellung', createdBy: demoUser('markus').id });
    const { draft } = await finishCallWith(lead.leadid, 'meeting_booked', { decisionMakerInMeeting: true });
    const cs = draft.changeSet!;
    await t.ctx.db.update(mockCrmLeads).set({ subject: 'Offerte ERP (Manuel)' }).where(eq(mockCrmLeads.leadid, lead.leadid));
    const first = (await send('POST', `/api/changesets/${cs.id}/push`, {})).json();
    expect(first.status).toBe('conflict');
    const c = first.changeSet.conflicts.find((x: { field: string }) => x.field === 'subject');
    expect(c).toMatchObject({ crmNow: 'Offerte ERP (Manuel)', newValue: 'KI Termin' });
    // nothing written yet
    expect((await t.ctx.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, lead.leadid)))[0].kls_callstatus).toBe(lead.kls_callstatus);

    const second = (await send('POST', `/api/changesets/${cs.id}/push`, { resolutions: { [c.opId]: 'keep_crm' } })).json();
    expect(second.status).toBe('pushed');
    const [row] = await t.ctx.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, lead.leadid));
    expect(row.subject).toBe('Offerte ERP (Manuel)');
    expect(row.kls_callstatus).toBe(CALL_STATUS.MEETING_BOOKED);
    expect(row.decisionmaker).toBe(true);
  });

  it('partial failure stays as draft («failed») and the retry only pushes what failed', async () => {
    const lead = await freshLead();
    // An open task of the company → the rule adapts it; we delete it before the push so that this op fails.
    await t.ctx.db.insert(mockCrmTasks).values({ activityid: `t-${lead.leadid}`, regardingLeadId: lead.leadid, subject: 'Alt', ownerid: MARKUS_CRM, statecode: 0, scheduledend: new Date(Date.now() + 5 * 86_400_000) });
    const { draft } = await finishCallWith(lead.leadid, 'waiting');
    const cs = draft.changeSet!;
    expect(cs.tasks[0]).toMatchObject({ action: 'update', taskId: `t-${lead.leadid}` });
    const saved = (await t.ctx.db.select().from(mockCrmTasks).where(eq(mockCrmTasks.activityid, `t-${lead.leadid}`)))[0];
    await t.ctx.db.delete(mockCrmTasks).where(eq(mockCrmTasks.activityid, `t-${lead.leadid}`));

    const failed = (await send('POST', `/api/changesets/${cs.id}/push`, {})).json();
    expect(failed.status).toBe('failed');
    expect(failed.changeSet.error).toMatch(/fehlgeschlagen/);
    const pending = (await get('/api/changesets?status=failed')).json().items as ChangeSet[];
    expect(pending.some((x) => x.id === cs.id)).toBe(true);
    expect((await get('/api/calls?scope=unfinished')).json().items.some((c: { changeSetId: string }) => c.changeSetId === cs.id)).toBe(true);

    await t.ctx.db.insert(mockCrmTasks).values(saved);
    const retry = (await send('POST', `/api/changesets/${cs.id}/push`, {})).json();
    expect(retry.status).toBe('pushed');
    const pcs = await t.ctx.db.select().from(mockCrmActivities).where(and(eq(mockCrmActivities.regardingLeadId, lead.leadid), eq(mockCrmActivities.kls_anrufergebnis, RESULT_GROUP_CODES.waiting)));
    expect(pcs).toHaveLength(1); // not duplicated by the retry
  });

  it('other contact person (6.8): new lead of the same company, previous lead becomes Zweitkontakt', async () => {
    const crm = t.ctx.adapters.system().crm;
    const openLeadsOf = async (id: string) => (await crm.getCompanyPersons(id)).filter((p) => p.source === 'lead' && p.statecode === 0).length;
    // A company that already has 2 open leads → blocked (max. 2 per company).
    let full: Lead | null = null;
    let single: Lead | null = null;
    for (let i = 0; i < 40 && (!full || !single); i++) {
      const l = await freshLead((x) => !!x.domain);
      const n = await openLeadsOf(l.leadid);
      if (n >= 2 && !full) full = l;
      else if (n === 1 && !single) single = l;
    }
    const person = { firstname: 'Beat', lastname: 'Neumann', jobtitle: 'CFO', email: 'beat@example.ch', phone: '079 555 11 22', samePerson: false };
    if (full) {
      const blocked = await finishCallWith(full.leadid, 'waiting', { newPerson: person });
      expect(blocked.draft.issues[0].field).toBe('newPerson');
      await send('POST', `/api/calls/${blocked.call.id}/abandon`).catch(() => undefined);
      const d = await send('POST', '/api/changesets', { leadId: full.leadid, callSessionId: blocked.call.id, ruleKey: 'has_partner', input: {} });
      await send('POST', `/api/changesets/${d.json().changeSet.id}/push`, {});
    }
    expect(single).not.toBeNull();
    const lead = single!;
    const { draft } = await finishCallWith(lead.leadid, 'waiting', { newPerson: person });
    const cs = draft.changeSet!;
    expect(cs.leadCreates).toHaveLength(1);
    const res = (await send('POST', `/api/changesets/${cs.id}/push`, {})).json();
    expect(res.status).toBe('pushed');
    const newId = res.changeSet.results.find((r: { kind: string }) => r.kind === 'lead_create').createdId;
    const [created] = await t.ctx.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, newId));
    expect(created).toMatchObject({ lastname: 'Neumann', companyname: lead.companyname, domain: lead.domain, telephone1: '+41 79 555 11 22', ownerid: MARKUS_CRM, statecode: 0, statuscode: STATUS.NEW });
    const [old] = await t.ctx.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, lead.leadid));
    expect(old.statuscode).toBe(STATUS.SECOND_CONTACT);
  });

  it('object-level access: admin sees other change sets, «Ansicht als Coldcaller» does not', async () => {
    const mine = (await get('/api/changesets?status=pushed')).json().items as ChangeSet[];
    expect(mine.length).toBeGreaterThan(0);
    const lukas = await t.login('lukas', { fresh: true });
    expect((await get(`/api/changesets/${mine[0].id}`, lukas)).statusCode).toBe(200);
    expect((await get(`/api/changesets?all=true`, lukas)).statusCode).toBe(200);
    expect((await send('PUT', '/api/me/view-as', { role: 'coldcaller' }, lukas)).statusCode).toBe(200);
    expect((await get(`/api/changesets/${mine[0].id}`, lukas)).statusCode).toBe(404);
    expect((await get(`/api/changesets?all=true`, lukas)).statusCode).toBe(403);
    expect((await get('/api/calls?all=true', lukas)).statusCode).toBe(403);
    // Markus cannot see Lukas' calls either
    expect((await get(`/api/changesets?userId=${demoUser('lukas').id}`)).statusCode).toBe(403);
  });

  it('workspace: objections, use cases, call reason, active call', async () => {
    const lead = await freshLead();
    const call = await startCall(lead.leadid);
    const ws = (await get(`/api/workspace/${lead.leadid}`)).json();
    expect(ws.objections.length).toBeGreaterThanOrEqual(4);
    expect(ws.useCases.length).toBeGreaterThan(0);
    expect(ws.callReason).toBeTruthy();
    expect(ws.activeCall.id).toBe(call.id);
    expect(ws.canCall).toBe(true);
    await send('POST', `/api/calls/${call.id}/abandon`);
  });
});

describe('use-case suggestions', () => {
  it('match the KI-Bewertung first, then the industry, max 3', () => {
    const s = suggestUseCases({
      kls_ki_bewertung: null,
      kls_custom_industry: null,
      kls_industry: 'Bau',
      assessment: { stand: null, grade: null, einstieg: 'Offerten und Ausschreibungen dauern lange', stichworte: ['Qualität'], naechsterSchritt: null, organisation: null, details: [] },
    });
    expect(s.map((u) => u.id)).toEqual(['UC-OFFER', 'UC-QA', 'UC-TENDER']);
    expect(suggestUseCases({ kls_ki_bewertung: null, kls_custom_industry: null, kls_industry: null, assessment: null }).map((u) => u.id)).toEqual(['UC-DOC']);
  });
});
