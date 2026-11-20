import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CALL_STATUS, LEAD_SUPPORT, RESULT_GROUP_CODES, type ChangeSet } from '@sales-portal/shared';
import { eq } from 'drizzle-orm';
import type { AppConfig } from '../src/config';
import { auditLog } from '../src/db/schema';
import type { DbHandle } from '../src/db/client';
import { invalidateLiveCrmCaches, LiveCrmAdapter } from '../src/integrations/crm/live';
import { AppError } from '../src/lib/errors';
import { API, closeTestDb, deps, fakeFetch, liveConfig, MARKUS_ACTOR, testDb, testRuntime, tokenRoute, type FakeResponse, type RecordedRequest } from './live-helpers';

const LEAD1 = '10000000-0000-4000-8000-000000000001';
const LEAD2 = '10000000-0000-4000-8000-000000000002';
const LEAD3 = '10000000-0000-4000-8000-000000000003';
const OWNER = '44444444-4444-4444-8444-444444444444';
const CAMPAIGN_SENDER = '55555555-5555-4555-8555-555555555555';
const NOTE_ID = '20000000-0000-4000-8000-000000000001';
const CALL_ID = '20000000-0000-4000-8000-000000000002';
const TASK_ID = '20000000-0000-4000-8000-000000000003';

const FMT = '@OData.Community.Display.V1.FormattedValue';
const LOOKUP = '@Microsoft.Dynamics.CRM.lookuplogicalname';

const leadRow = (id: string, extra: Record<string, unknown> = {}) => ({
  '@odata.etag': 'W/"100"',
  leadid: id,
  companyname: `Firma ${id.slice(-1)}`,
  firstname: 'Anna',
  lastname: 'Muster',
  telephone1: '061 123 45 67',
  mobilephone: null,
  websiteurl: `www.firma${id.slice(-1)}.ch`,
  numberofemployees: 25,
  kls_leadscore: 80,
  kls_callstatus: null,
  statecode: 0,
  statuscode: 1,
  donotphone: false,
  donotemail: false,
  donotbulkemail: false,
  kls_interests: '845140000',
  _ownerid_value: OWNER,
  [`_ownerid_value${FMT}`]: 'Markus Caller',
  createdon: '2026-01-01T00:00:00Z',
  modifiedon: '2026-11-01T00:00:00Z',
  ...extra,
});

const decoded = (req: RecordedRequest) => decodeURIComponent(req.url);
const pathOf = (req: RecordedRequest) => req.url.slice(API.length);

let config: AppConfig;
let handle: DbHandle;

beforeAll(async () => {
  config = liveConfig({ DATAVERSE_CAMPAIGN_SENDER_IDS: CAMPAIGN_SENDER });
  handle = await testDb(config);
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(() => invalidateLiveCrmCaches());

/** Dataverse fake: `extra` routes first, then default reads. */
function dataverse(extra: ((req: RecordedRequest) => FakeResponse | undefined)[] = []) {
  const ff = fakeFetch([
    tokenRoute(),
    ...extra,
    (req) => {
      if (req.method !== 'GET') return undefined;
      const p = pathOf(req);
      if (p.startsWith('leads?')) {
        if (req.url.includes('skiptoken=2')) return { body: { value: [leadRow(LEAD3, { statecode: 2, statuscode: 6 })] } };
        return {
          body: {
            value: [leadRow(LEAD1), leadRow(LEAD2, { kls_lead_support: LEAD_SUPPORT.CAMPAIGN, kls_leadscore: 90 })],
            '@odata.nextLink': `${API}leads?$skiptoken=2`,
          },
        };
      }
      if (p.startsWith('tasks?'))
        return { body: { value: [{ activityid: TASK_ID, scheduledend: '2026-11-21T08:00:00Z', _regardingobjectid_value: LEAD1, [`_regardingobjectid_value${LOOKUP}`]: 'lead' }] } };
      if (p.startsWith('accounts?')) return { body: { value: [] } };
      if (p.startsWith('emails?')) {
        return {
          body: {
            value: decoded(req).includes(LEAD2)
              ? [
                  {
                    activityid: '30000000-0000-4000-8000-000000000001',
                    subject: 'Ideen für Ihre Firma',
                    directioncode: true,
                    createdon: '2026-11-10T08:00:00Z',
                    statecode: 1,
                    _createdby_value: CAMPAIGN_SENDER,
                    _regardingobjectid_value: LEAD2,
                  },
                ]
              : [],
          },
        };
      }
      if (p.startsWith('phonecalls?')) {
        return {
          body: {
            value: decoded(req).includes(LEAD1)
              ? [
                  {
                    activityid: CALL_ID,
                    subject: 'Anruf Firma 1 – Rückruf',
                    directioncode: true,
                    actualstart: '2026-11-18T09:00:00Z',
                    actualend: '2026-11-18T09:05:00Z',
                    createdon: '2026-11-18T09:00:00Z',
                    statecode: 1,
                    kls_anrufergebnis: 845140001,
                    _regardingobjectid_value: LEAD1,
                    [`_regardingobjectid_value${LOOKUP}`]: 'lead',
                    _ownerid_value: OWNER,
                  },
                ]
              : [],
          },
        };
      }
      if (p.startsWith('appointments?') || p.startsWith('annotations?')) return { body: { value: [] } };
      return undefined;
    },
  ]);
  return ff;
}

function adapter(ff: ReturnType<typeof fakeFetch>, auth: Parameters<typeof deps>[2] = { kind: 'system' }) {
  return new LiveCrmAdapter(deps(config, handle.db, auth), testRuntime(config, ff.fetch));
}

describe('live CRM – reading', () => {
  it('lists leads with paging via @odata.nextLink, formatted values and the shared rules', async () => {
    const ff = dataverse();
    const page = await adapter(ff).listLeads({});
    const leadCalls = ff.calls.filter((c) => pathOf(c).startsWith('leads?'));
    expect(leadCalls).toHaveLength(2);
    expect(leadCalls[1].url).toBe(`${API}leads?$skiptoken=2`);
    expect(decoded(leadCalls[0])).toContain('$filter=(statecode eq 0) and (donotphone eq false)');
    expect(leadCalls[0].headers.prefer).toContain('odata.include-annotations');
    expect(leadCalls[0].headers.prefer).toContain('odata.maxpagesize=500');
    expect(leadCalls[0].headers.authorization).toMatch(/^Bearer tok-client_credentials/);
    // LEAD2 is a locked campaign lead, LEAD3 closed → only LEAD1 is callable.
    expect(page.items.map((l) => l.leadid)).toEqual([LEAD1]);
    const lead = page.items[0];
    expect(lead.grade).toBe('A');
    expect(lead.ownerName).toBe('Markus Caller');
    expect(lead.primaryPhone?.e164).toBe('+41611234567');
    expect(lead.nextDueAt).toBe('2026-11-21T08:00:00.000Z');
    expect(lead.lastRealContact?.activityId).toBe(CALL_ID);
    expect(lead.domain).toBe('firma1.ch');
  });

  it('admin view: hidden leads with campaign lock from campaign mails', async () => {
    const ff = dataverse();
    const page = await adapter(ff).listLeads({ includeHidden: true, campaign: 'all' });
    const lead2 = page.items.find((l) => l.leadid === LEAD2);
    expect(page.total).toBe(3);
    expect(lead2?.campaign.inCampaign).toBe(true);
    expect(lead2?.campaign.locked).toBe(true);
    expect(lead2?.exclusions).toContain('campaign_locked');
    expect(page.items.find((l) => l.leadid === LEAD3)?.exclusions).toContain('closed');
  });

  it('never follows a nextLink to another host', async () => {
    const ff = dataverse([
      (req) => (pathOf(req).startsWith('leads?') ? { body: { value: [leadRow(LEAD1)], '@odata.nextLink': 'https://evil.example/api/data/v9.2/leads?x' } } : undefined),
    ]);
    await adapter(ff).listLeads({});
    expect(ff.calls.some((c) => c.url.includes('evil.example'))).toBe(false);
  });

  it('«Nicht erreicht»: no retry in the same half-day (nextAttemptAt from the newest call, INTENT 6.1)', async () => {
    // NOW = Fri 20.11.2026 10:00 Zurich. LEAD1 not reached at 09:10 today → next attempt 13:00 (12:00Z).
    // LEAD2 not reached on Wednesday → due again. LEAD3: today's call, but the call status no longer says «Nicht erreicht».
    const call = (id: string, lead: string, at: string, result: number, statecode = 1) => ({
      activityid: id,
      subject: 'Anruf',
      directioncode: true,
      actualstart: at,
      createdon: at,
      statecode,
      kls_anrufergebnis: result,
      _regardingobjectid_value: lead,
      [`_regardingobjectid_value${LOOKUP}`]: 'lead',
    });
    const calls = [
      call('20000000-0000-4000-8000-000000000011', LEAD1, '2026-11-20T08:10:00Z', RESULT_GROUP_CODES.not_reached),
      call('20000000-0000-4000-8000-000000000012', LEAD1, '2026-11-19T08:00:00Z', RESULT_GROUP_CODES.not_reached),
      // A cancelled newer call does not count.
      call('20000000-0000-4000-8000-000000000013', LEAD2, '2026-11-20T08:30:00Z', RESULT_GROUP_CODES.not_reached, 2),
      call('20000000-0000-4000-8000-000000000014', LEAD2, '2026-11-18T08:00:00Z', RESULT_GROUP_CODES.not_reached),
      call('20000000-0000-4000-8000-000000000015', LEAD3, '2026-11-20T08:20:00Z', RESULT_GROUP_CODES.not_reached),
    ];
    const rows = [
      leadRow(LEAD1, { kls_callstatus: CALL_STATUS.NOT_REACHED }),
      leadRow(LEAD2, { kls_callstatus: CALL_STATUS.NOT_REACHED, kls_leadscore: 70 }),
      leadRow(LEAD3, { kls_callstatus: null, kls_leadscore: 60 }),
    ];
    const routes = [
      (req: RecordedRequest) => (req.method === 'GET' && pathOf(req).startsWith('leads?') ? { body: { value: rows } } : undefined),
      (req: RecordedRequest) => (req.method === 'GET' && req.url.startsWith(`${API}leads(${LEAD1})`) ? { body: rows[0] } : undefined),
      (req: RecordedRequest) => (req.method === 'GET' && pathOf(req).startsWith('emails?') ? { body: { value: [] } } : undefined),
      (req: RecordedRequest) =>
        req.method === 'GET' && pathOf(req).startsWith('phonecalls?') ? { body: { value: calls.filter((c) => decoded(req).includes(c._regardingobjectid_value)) } } : undefined,
    ];

    const ff = dataverse(routes);
    const all = await adapter(ff).listLeads({});
    const byId = new Map(all.items.map((l) => [l.leadid, l]));
    expect(byId.get(LEAD1)?.nextAttemptAt).toBe('2026-11-20T12:00:00.000Z');
    expect(byId.get(LEAD2)?.nextAttemptAt).toBe('2026-11-18T12:00:00.000Z');
    expect(byId.get(LEAD3)?.nextAttemptAt).toBeNull();
    // Only «Nicht erreicht» leads are checked, and only their recent calls are loaded.
    const retryQuery = decoded(ff.calls.find((c) => pathOf(c).startsWith('phonecalls?'))!);
    expect(retryQuery).toContain(LEAD1);
    expect(retryQuery).toContain(LEAD2);
    expect(retryQuery).not.toContain(LEAD3);
    expect(retryQuery).toContain('actualstart ge 2026-11-13T09:00:00.000Z');

    invalidateLiveCrmCaches();
    const callList = await adapter(dataverse(routes)).listLeads({ hideRetryPending: true });
    expect(callList.items.map((l) => l.leadid)).toEqual([LEAD2, LEAD3]);

    // Lead detail (all activities loaded) uses the same rule.
    const lead = await adapter(dataverse(routes)).getLead(LEAD1);
    expect(lead?.nextAttemptAt).toBe('2026-11-20T12:00:00.000Z');
  });

  it('reads field values for the conflict check (lookups, multi-select, missing → {})', async () => {
    const ff = dataverse([
      (req) => (req.url.startsWith(`${API}leads(${LEAD1})`) ? { body: leadRow(LEAD1) } : undefined),
      (req) => (req.url.startsWith(`${API}leads(${LEAD2})`) ? { status: 404, body: { error: { code: '0x80040217' } } } : undefined),
    ]);
    const crm = adapter(ff);
    expect(await crm.getFieldValues('lead', LEAD1, ['ownerid', 'kls_interests', 'kls_callstatus'])).toEqual({
      ownerid: OWNER,
      kls_interests: [845140000],
      kls_callstatus: null,
    });
    expect(decoded(ff.calls.at(-1)!)).toContain('$select=_ownerid_value,kls_interests,kls_callstatus');
    expect(await crm.getFieldValues('lead', LEAD2, ['statecode'])).toEqual({});
    expect(await crm.getFieldValues('lead', "x' or 1 eq 1", ['statecode'])).toEqual({});
  });

  it('maps Dataverse errors to safe AppErrors', async () => {
    const ff = dataverse([(req) => (req.url.startsWith(`${API}leads(`) ? { status: 403, body: { error: { code: '0x80040220', message: 'Principal user (Id=…) is missing prvReadLead' } } } : undefined)]);
    const err = await adapter(ff).getLead(LEAD1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(403);
    expect((err as AppError).message).not.toContain('prvReadLead');
  });

  it('callback search: server-side filter on number variants, in-memory exact match, last call', async () => {
    const ff = dataverse([
      (req) => {
        const p = pathOf(req);
        if (p.startsWith('leads?') && decoded(req).includes('telephone1 eq')) {
          return { body: { value: [leadRow(LEAD1), leadRow(LEAD2, { telephone1: '061 999 45 67' })] } };
        }
        if (p.startsWith('contacts?')) return { body: { value: [] } };
        if (p.startsWith('accounts?')) return { body: { value: [] } };
        return undefined;
      },
    ]);
    const matches = await adapter(ff).searchByPhone('0041 61 123 45 67');
    const leadQuery = decoded(ff.calls.find((c) => pathOf(c).startsWith('leads?') && decoded(c).includes('telephone1 eq'))!);
    expect(leadQuery).toContain("telephone1 eq '+41 61 123 45 67'");
    expect(leadQuery).toContain("mobilephone eq '061 123 45 67'");
    expect(leadQuery).toContain("contains(telephone1,'45 67')");
    // LEAD2 only shares the suffix → removed by the exact in-memory check.
    expect(matches.map((m) => m.leadId)).toEqual([LEAD1]);
    expect(matches[0].lastCall?.id).toBe(CALL_ID);
  });
});

function changeSet(partial: Partial<ChangeSet>): ChangeSet {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    leadId: LEAD1,
    kind: 'call_result',
    ruleVersion: 1,
    operations: [],
    activities: [],
    tasks: [],
    notes: [],
    stateChanges: [],
    leadCreates: [],
    baseSnapshot: {},
    status: 'pending',
    conflicts: [],
    results: [],
    createdBy: MARKUS_ACTOR.userId,
    createdAt: '2026-11-20T08:00:00Z',
    updatedAt: '2026-11-20T08:00:00Z',
    ...partial,
  };
}

const batchOk = (n: number) => ({
  text: [
    '--batchresponse_x',
    'Content-Type: multipart/mixed; boundary=changesetresponse_x',
    '',
    ...Array.from({ length: n }, (_, i) => ['--changesetresponse_x', 'Content-Type: application/http', `Content-ID: ${i + 1}`, '', 'HTTP/1.1 204 No Content', '', '']).flat(),
    '--changesetresponse_x--',
    '--batchresponse_x--',
  ].join('\r\n'),
  headers: { 'content-type': 'multipart/mixed; boundary=batchresponse_x' },
});

/** Write routes: create → id from OData-EntityId; GET lead/phonecall for ETag/state. */
function writeRoutes(options: { batch?: FakeResponse; lead?: Record<string, unknown>; phonecallState?: number } = {}) {
  const created: Record<string, string> = { annotations: NOTE_ID, phonecalls: CALL_ID, tasks: TASK_ID };
  return [
    (req: RecordedRequest) => {
      const p = pathOf(req);
      if (req.method === 'POST' && created[p]) return { status: 204, headers: { 'OData-EntityId': `${API}${p}(${created[p]})` } };
      if (req.method === 'POST' && p === '$batch') return options.batch ?? { status: 200, ...batchOk(1) };
      if (req.method === 'PATCH') return { status: 204 };
      if (req.method === 'GET' && p.startsWith(`leads(${LEAD1})`)) return { body: { ...leadRow(LEAD1, { kls_callstatus: 845140001 }), ...options.lead } };
      if (req.method === 'GET' && p.startsWith(`phonecalls(${CALL_ID})`)) return { body: { '@odata.etag': 'W/"7"', statecode: options.phonecallState ?? 1, statuscode: 2 } };
      if (req.method === 'GET' && p.startsWith(`tasks(${TASK_ID})`)) return { body: { '@odata.etag': 'W/"8"', statecode: 0, statuscode: 2, scheduledend: '2026-11-21T08:00:00Z' } };
      return undefined;
    },
  ];
}

describe('live CRM – push (applyChangeSet)', () => {
  const fullChangeSet = () =>
    changeSet({
      notes: [{ id: 'n1', leadId: LEAD1, text: 'Sales-Portal: Nicht qualifiziert – zu klein' }],
      operations: [
        { id: 'f1', entity: 'lead', entityId: LEAD1, field: 'kls_callstatus', label: 'Anrufstatus', oldValue: 845140001, newValue: 845140007, mode: 'set' },
        { id: 'f2', entity: 'lead', entityId: LEAD1, field: 'ownerid', label: 'Besitzer', oldValue: OWNER, newValue: MARKUS_ACTOR.crmUserId, mode: 'set' },
        { id: 'f3', entity: 'lead', entityId: LEAD1, field: 'kls_interests', label: 'Interessen', oldValue: [845140000], newValue: 845140014, mode: 'add_to_multiselect' },
        { id: 'f4', entity: 'lead', entityId: LEAD1, field: 'numberofemployees', label: 'MA', oldValue: 25, newValue: 3, mode: 'set_if_empty' },
      ],
      activities: [
        { id: 'a1', action: 'create', type: 'phonecall', leadId: LEAD1, subject: 'Anruf Firma 1 – Zu klein', text: 'Nur 3 MA', direction: 'outgoing', start: '2026-11-20T08:50:00Z', end: '2026-11-20T08:55:00Z', durationSec: 300, resultCode: 845140010 },
      ],
      tasks: [{ id: 't1', action: 'create', leadId: LEAD1, subject: 'Nachfassen', dueAt: '2026-11-27T08:00:00Z', ownerId: MARKUS_ACTOR.crmUserId, taskType: 'follow_up' }],
      stateChanges: [{ id: 's1', leadId: LEAD1, statecode: 2, statuscode: 845140003, label: 'Disqualifiziert' }],
      baseSnapshot: {
        [`lead:${LEAD1}:kls_callstatus`]: 845140001,
        [`lead:${LEAD1}:ownerid`]: OWNER,
        [`lead:${LEAD1}:kls_interests`]: [845140000],
      },
    });

  it('pushes Notiz → Felder ($batch with ETag) → Aktivität → Aufgabe → Status, with results and audit', async () => {
    const ff = dataverse(writeRoutes());
    const result = await adapter(ff, { kind: 'user', userId: MARKUS_ACTOR.userId, email: MARKUS_ACTOR.email, sessionIdHash: null }).applyChangeSet(fullChangeSet(), MARKUS_ACTOR);
    expect(result.ok).toBe(true);
    expect(result.phonecallId).toBe(CALL_ID);
    expect(result.results.map((r) => [r.opId, r.ok])).toEqual([
      ['n1', true],
      ['f1', true],
      ['f2', true],
      ['f3', true],
      ['f4', true],
      ['a1', true],
      ['t1', true],
      ['s1', true],
    ]);

    const writes = ff.calls.filter((c) => c.method !== 'GET' && !c.url.includes('oauth2')).map((c) => `${c.method} ${pathOf(c).split('?')[0]}`);
    expect(writes).toEqual([
      'POST annotations',
      'POST $batch',
      'POST phonecalls',
      `PATCH phonecalls(${CALL_ID})`, // close as «Made»
      'POST tasks',
      `PATCH leads(${LEAD1})`, // status last
    ]);

    const note = JSON.parse(ff.calls.find((c) => pathOf(c) === 'annotations')!.body);
    expect(note).toMatchObject({ notetext: 'Sales-Portal: Nicht qualifiziert – zu klein', 'objectid_lead@odata.bind': `/leads(${LEAD1})` });

    const batch = ff.calls.find((c) => pathOf(c) === '$batch')!;
    expect(batch.headers['content-type']).toMatch(/^multipart\/mixed; boundary=batch_/);
    expect(batch.body).toContain(`PATCH ${API}leads(${LEAD1}) HTTP/1.1`);
    expect(batch.body).toContain('If-Match: W/"100"');
    const patchBody = JSON.parse(batch.body.split('\r\n').find((l) => l.startsWith('{'))!);
    expect(patchBody).toEqual({
      kls_callstatus: 845140007,
      'ownerid@odata.bind': `/systemusers(${MARKUS_ACTOR.crmUserId})`,
      kls_interests: '845140000,845140014',
    }); // numberofemployees already filled → set_if_empty skipped

    const call = JSON.parse(ff.calls.find((c) => pathOf(c) === 'phonecalls' && c.method === 'POST')!.body);
    expect(call).toMatchObject({
      directioncode: true,
      actualdurationminutes: 5,
      kls_anrufergebnis: 845140010,
      'regardingobjectid_lead_phonecall@odata.bind': `/leads(${LEAD1})`,
    });
    expect(call.phonecall_activity_parties).toEqual([
      { participationtypemask: 1, 'partyid_systemuser@odata.bind': `/systemusers(${MARKUS_ACTOR.crmUserId})` },
      { participationtypemask: 2, 'partyid_lead@odata.bind': `/leads(${LEAD1})` },
    ]);
    const state = ff.calls.filter((c) => c.method === 'PATCH' && pathOf(c) === `leads(${LEAD1})`).at(-1)!;
    expect(JSON.parse(state.body)).toEqual({ statecode: 2, statuscode: 845140003 });
    expect(state.headers['if-match']).toBe('W/"100"');

    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.changeSetId, '99999999-9999-4999-8999-999999999999'));
    const actions = rows.map((r) => `${r.action}:${r.field ?? ''}`).sort();
    expect(actions).toEqual(
      [
        'crm.activity_create:',
        'crm.field_update:kls_callstatus',
        'crm.field_update:kls_interests',
        'crm.field_update:ownerid',
        'crm.note_create:',
        'crm.state_change:statecode/statuscode',
        'crm.task_create:',
      ].sort(),
    );
    expect(rows.find((r) => r.field === 'kls_callstatus')).toMatchObject({ oldValue: 845140001, newValue: 845140007, actorLabel: 'Markus' });
  });

  it('field changed in the CRM since the draft → conflict per field, status not changed', async () => {
    const ff = dataverse(writeRoutes({ lead: { kls_callstatus: 845140008 } }));
    const result = await adapter(ff).applyChangeSet(fullChangeSet(), MARKUS_ACTOR);
    expect(result.ok).toBe(false);
    const byOp = Object.fromEntries(result.results.map((r) => [r.opId, r]));
    expect(byOp.f1.ok).toBe(false);
    expect(byOp.f1.error).toMatch(/Konflikt/);
    expect(byOp.f2.ok).toBe(true); // other fields of the same record are still written
    expect(byOp.s1.ok).toBe(false);
    expect(ff.calls.some((c) => c.method === 'PATCH' && JSON.parse(c.body || '{}').statecode === 2)).toBe(false);
    expect(ff.calls.find((c) => pathOf(c) === '$batch')!.body).not.toContain('kls_callstatus');
  });

  it('explicit «overwrite» decision writes despite the conflict; «keep_crm» skips the field', async () => {
    const ff = dataverse(writeRoutes({ lead: { kls_callstatus: 845140008 } }));
    const cs = fullChangeSet();
    cs.conflicts = [
      { opId: 'f1', field: 'kls_callstatus', label: 'Anrufstatus', draftValue: 845140001, crmNow: 845140008, newValue: 845140007, resolution: 'overwrite' },
      { opId: 'f3', field: 'kls_interests', label: 'Interessen', draftValue: [845140000], crmNow: [845140000], newValue: 845140014, resolution: 'keep_crm' },
    ];
    const result = await adapter(ff).applyChangeSet(cs, MARKUS_ACTOR);
    expect(result.ok).toBe(true);
    const patch = JSON.parse(ff.calls.find((c) => pathOf(c) === '$batch')!.body.split('\r\n').find((l) => l.startsWith('{'))!);
    expect(patch.kls_callstatus).toBe(845140007);
    expect(patch.kls_interests).toBeUndefined();
  });

  it('ETag mismatch (412) in the change set → typed conflict for all field ops, nothing after it changes the status', async () => {
    const conflict = {
      status: 200,
      text: [
        '--batchresponse_x',
        'Content-Type: application/http',
        'Content-ID: 1',
        '',
        'HTTP/1.1 412 Precondition Failed',
        'Content-Type: application/json',
        '',
        '{"error":{"code":"0x80060882","message":"The version of the existing record doesn\'t match"}}',
        '--batchresponse_x--',
      ].join('\r\n'),
    };
    const ff = dataverse(writeRoutes({ batch: conflict }));
    const result = await adapter(ff).applyChangeSet(fullChangeSet(), MARKUS_ACTOR);
    const byOp = Object.fromEntries(result.results.map((r) => [r.opId, r]));
    for (const id of ['f1', 'f2', 'f3']) {
      expect(byOp[id].ok).toBe(false);
      expect(byOp[id].error).toBe('Konflikt: Datensatz wurde inzwischen im CRM geändert');
    }
    expect(byOp.n1.ok).toBe(true);
    expect(byOp.s1.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('a failed note blocks the disqualification (never disqualify without the note)', async () => {
    const ff = dataverse([(req) => (req.method === 'POST' && pathOf(req) === 'annotations' ? { status: 500, body: { error: { code: 'x' } } } : undefined), ...writeRoutes()]);
    const cs = changeSet({ notes: [{ id: 'n1', leadId: LEAD1, text: 'Sales-Portal: Nicht qualifiziert' }], stateChanges: [{ id: 's1', leadId: LEAD1, statecode: 2, statuscode: 6, label: 'x' }] });
    const result = await adapter(ff).applyChangeSet(cs, MARKUS_ACTOR);
    expect(result.results).toEqual([
      expect.objectContaining({ opId: 'n1', ok: false }),
      expect.objectContaining({ opId: 's1', ok: false, error: expect.stringMatching(/vorheriger Schritt/) }),
    ]);
    expect(ff.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('updates a closed phone call by reopening and closing it again', async () => {
    const ff = dataverse(writeRoutes({ phonecallState: 1 }));
    await adapter(ff).updatePhoneCall(CALL_ID, { durationSec: 412, interest: 2, text: 'Notiz + Zusammenfassung' }, MARKUS_ACTOR);
    const patches = ff.calls.filter((c) => c.method === 'PATCH').map((c) => JSON.parse(c.body));
    expect(patches).toEqual([
      { statecode: 0, statuscode: 1 },
      { actualdurationminutes: 7, description: 'Notiz + Zusammenfassung', kls_interesse: 2 },
      { statecode: 1, statuscode: 2 },
    ]);
    expect(ff.calls.filter((c) => c.method === 'PATCH')[0].headers['if-match']).toBe('W/"7"');
  });

  it('completes and reschedules tasks with audit', async () => {
    const ff = dataverse(writeRoutes());
    const crm = adapter(ff);
    await crm.completeTask(TASK_ID, MARKUS_ACTOR);
    await crm.rescheduleTask(TASK_ID, '2026-12-01T08:00:00Z', MARKUS_ACTOR);
    const patches = ff.calls.filter((c) => c.method === 'PATCH').map((c) => JSON.parse(c.body));
    expect(patches).toEqual([{ statecode: 1, statuscode: 5 }, { scheduledend: '2026-12-01T08:00:00.000Z' }]);
    await expect(crm.completeTask('not-a-guid', MARKUS_ACTOR)).rejects.toMatchObject({ statusCode: 404 });
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.entityId, TASK_ID));
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['crm.task_complete', 'crm.task_reschedule']));
  });
});
