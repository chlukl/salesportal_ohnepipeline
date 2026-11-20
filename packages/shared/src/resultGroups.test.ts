import { describe, expect, it } from 'vitest';
import { CALL_STATUS, INTEREST_KI_SERVICES, LEAD_SUPPORT, RATING, RESULT_GROUP_CODES, STATE, STATUS } from './i18n';
import { CALLBACK_STATUS_BY_DATE, DEFAULT_RESULT_GROUP_RULES } from './resultGroupDefaults';
import {
  buildChangeSet,
  buildRevertDraft,
  callStatusForDate,
  detectConflicts,
  evaluateCondition,
  fieldsToReread,
  followUpMailSent,
  followUpRequirement,
  pendingPart,
  resolveConflicts,
  RESULT_SHORTCUT_RESERVED,
  resultGroupShortcuts,
  ResultInputError,
  snapshotKey,
  validateResultInput,
  type BuildChangeSetInput,
} from './resultGroups';
import { formatZurich } from './time';
import type { Actor, CrmTask, Lead, ResultGroupKey, ResultInput } from './types';

// Tuesday 17.11.2026, 10:00 Zurich
const now = new Date('2026-11-17T09:00:00Z');
const MARKUS = 'crm-markus';
const actor: Actor = { kind: 'user', userId: 'u-markus', displayName: 'Markus', crmUserId: MARKUS, email: 'markus@example.ch' };

function lead(p: Partial<Lead> = {}): Lead {
  return {
    leadid: 'lead-1',
    companyname: 'Muster AG',
    firstname: 'Anna',
    lastname: 'Muster',
    fullname: 'Anna Muster',
    jobtitle: 'Geschäftsführerin',
    emailaddress1: 'anna@muster.example',
    telephone1: '061 123 45 67',
    mobilephone: null,
    websiteurl: 'https://muster.example',
    numberofemployees: 60,
    kls_industry: 'Maschinenbau',
    kls_custom_industry: null,
    kls_leadscore: 75,
    kls_ki_bewertung: 'Einstieg: Offerten',
    kls_callstatus: null,
    kls_rating_category: null,
    statecode: 0,
    statuscode: STATUS.NEW,
    ownerid: 'crm-sandra',
    ownerName: 'Sandra',
    subject: null,
    leadsourcecode: 845140000,
    kls_lead_support: null,
    kls_interests: [845140000],
    decisionmaker: null,
    donotphone: false,
    donotemail: false,
    donotbulkemail: false,
    kls_competitor: null,
    kls_salutation: null,
    address1_postalcode: '4051',
    address1_city: 'Basel',
    address1_stateorprovince: 'BS',
    createdon: '2026-10-01T08:00:00Z',
    modifiedon: '2026-11-01T08:00:00Z',
    parentaccountid: null,
    grade: 'A',
    employeeBand: '50-249',
    orgType: 'private',
    contactRole: 'management',
    phones: [],
    primaryPhone: { field: 'telephone1', raw: '061 123 45 67', status: 'ok', e164: '+41611234567', display: '+41 61 123 45 67', extension: null, country: 'CH', type: 'fixed', issue: null, candidates: [] },
    domain: 'muster.example',
    campaign: { inCampaign: false, campaignName: null, lastActivityAt: null, lockedUntil: null, locked: false, fromCampaign: false, positiveReply: false },
    lastRealContact: null,
    assessment: null,
    exclusions: [],
    nextDueAt: null,
    ...p,
  };
}

function task(p: Partial<CrmTask>): CrmTask {
  return {
    id: 'task-x',
    leadId: 'lead-1',
    leadName: null,
    companyName: 'Muster AG',
    subject: 'Alt',
    description: null,
    dueAt: '2026-11-25T08:00:00Z',
    ownerId: MARKUS,
    ownerName: 'Markus',
    statecode: 0,
    taskType: 'follow_up',
    createdon: '2026-11-10T08:00:00Z',
    completedon: null,
    ...p,
  };
}

const rule = (key: ResultGroupKey) => DEFAULT_RESULT_GROUP_RULES.find((r) => r.key === key)!;

const call = {
  id: 'call-1',
  dialedAt: '2026-11-17T08:50:00Z',
  connectedAt: '2026-11-17T08:51:00Z',
  endedAt: '2026-11-17T08:56:30Z',
  durationSec: null,
  noteDraft: '  Interesse an Offerten-Automatisierung, Budget Q1  ',
  phoneE164: '+41611234567',
  phoneDisplay: '+41 61 123 45 67',
  direction: 'outbound' as const,
};

function build(key: ResultGroupKey, input: ResultInput = {}, p: Partial<BuildChangeSetInput> = {}) {
  return buildChangeSet({
    rule: rule(key),
    lead: lead(),
    input,
    actor,
    callSession: call,
    openCompanyTasks: [],
    ownerOpenTasks: [],
    now,
    ...p,
  });
}

const field = (cs: ReturnType<typeof build>, name: string) => cs.operations.find((o) => o.field === name);
const fieldNames = (cs: ReturnType<typeof build>) => cs.operations.map((o) => o.field).sort();

describe('always rules (every group)', () => {
  it('phone call activity with kls_anrufergebnis, note text, times and duration from the clicks', () => {
    const cs = build('waiting');
    expect(cs.activities).toHaveLength(1);
    const a = cs.activities[0];
    expect(a).toMatchObject({
      action: 'create',
      type: 'phonecall',
      direction: 'outgoing',
      resultCode: RESULT_GROUP_CODES.waiting,
      text: 'Interesse an Offerten-Automatisierung, Budget Q1',
      subject: 'Anruf Muster AG – Wartet / Ansprechperson informiert',
      start: call.connectedAt.replace('Z', '.000Z'),
      durationSec: 330,
      phoneNumber: '+41 61 123 45 67',
    });
    expect(cs.notes).toEqual([]); // the note is in the call, never as «Sales-Portal:» note
    expect(cs.ruleKey).toBe('waiting');
    expect(cs.ruleVersion).toBe(1);
    expect(cs.kind).toBe('call_result');
    expect(cs.callSessionId).toBe('call-1');
  });

  it('inbound callback is an incoming call', () => {
    const cs = build('callback', { followUpAt: '2026-11-18T09:00:00Z' }, { callSession: { ...call, direction: 'inbound' } });
    expect(cs.activities[0]).toMatchObject({ direction: 'incoming', subject: 'Rückruf Muster AG – Rückruf vereinbart' });
  });

  it('owner → caller and Neu → Kontaktiert when someone was reached', () => {
    const cs = build('waiting');
    expect(field(cs, 'ownerid')).toMatchObject({ oldValue: 'crm-sandra', newValue: MARKUS, oldDisplay: 'Sandra', newDisplay: 'Markus' });
    expect(field(cs, 'statuscode')).toMatchObject({ oldValue: STATUS.NEW, newValue: STATUS.CONTACTED, newDisplay: 'Kontaktiert' });
  });

  it('«Austausch» and «Zweitkontakt» stay; owner unchanged if already the caller', () => {
    const cs = build('waiting', {}, { lead: lead({ statuscode: STATUS.EXCHANGE, ownerid: MARKUS, ownerName: 'Markus' }) });
    expect(field(cs, 'statuscode')).toBeUndefined();
    expect(field(cs, 'ownerid')).toBeUndefined();
  });

  it('records the old value of every field in the base snapshot', () => {
    const cs = build('meeting_booked', { decisionMakerInMeeting: true });
    for (const op of cs.operations) expect(cs.baseSnapshot[snapshotKey('lead', 'lead-1', op.field)]).toEqual(op.oldValue);
  });

  it('missing CRM user: no owner change and no task, but still the call', () => {
    const cs = build('waiting', {}, { actor: { ...actor, crmUserId: null } });
    expect(field(cs, 'ownerid')).toBeUndefined();
    expect(cs.tasks).toEqual([]);
    expect(cs.activities).toHaveLength(1);
  });
});

describe('groups (INTENT 6.5 table)', () => {
  it('Nicht erreicht: call status 845140001, nothing else, duration 0', () => {
    const cs = build('not_reached', {}, { callSession: { ...call, connectedAt: null, endedAt: '2026-11-17T08:50:40Z' } });
    expect(cs.kind).toBe('not_reached');
    expect(fieldNames(cs)).toEqual(['kls_callstatus']);
    expect(field(cs, 'kls_callstatus')?.newValue).toBe(CALL_STATUS.NOT_REACHED);
    expect(cs.activities[0]).toMatchObject({ resultCode: RESULT_GROUP_CODES.not_reached, durationSec: 0 });
    expect(cs.tasks).toEqual([]);
    expect(cs.stateChanges).toEqual([]);
  });

  it('Nicht erreicht keeps open tasks (nobody reached)', () => {
    const cs = build('not_reached', {}, { openCompanyTasks: [task({})] });
    expect(cs.tasks).toEqual([]);
  });

  it('Rückruf vereinbart: call status by date and callback task with date and time to the caller', () => {
    const cs = build('callback', { followUpAt: '2026-11-18T13:30:00Z' });
    expect(field(cs, 'kls_callstatus')?.newValue).toBe(CALL_STATUS.CALLBACK_TOMORROW);
    expect(cs.tasks).toHaveLength(1);
    expect(cs.tasks[0]).toMatchObject({ action: 'create', taskType: 'callback', dueAt: '2026-11-18T13:30:00.000Z', ownerId: MARKUS, subject: 'Rückruf Muster AG' });
  });

  it('Rückruf vereinbart requires a date', () => {
    expect(() => build('callback', {})).toThrow(ResultInputError);
    expect(() => build('callback', { followUpAt: '2026-11-10T09:00:00Z' })).toThrow(/Vergangenheit/);
  });

  it('Wartet: 845140008, follow-up task in 1 week', () => {
    const cs = build('waiting');
    expect(field(cs, 'kls_callstatus')?.newValue).toBe(CALL_STATUS.WAITING);
    expect(formatZurich(cs.tasks[0].dueAt!, 'dd.MM.yyyy HH:mm')).toBe('24.11.2026 09:00');
    expect(cs.tasks[0].subject).toBe('Nachfassen Muster AG');
  });

  it('Termin gebucht: Termin vereinbart, Verkauf, «KI Termin», interests added (not replaced), decision maker', () => {
    const cs = build('meeting_booked', { decisionMakerInMeeting: true });
    expect(field(cs, 'kls_callstatus')?.newValue).toBe(CALL_STATUS.MEETING_BOOKED);
    expect(field(cs, 'kls_lead_support')?.newValue).toBe(LEAD_SUPPORT.SALES);
    expect(field(cs, 'subject')?.newValue).toBe('KI Termin');
    expect(field(cs, 'kls_interests')).toMatchObject({ mode: 'add_to_multiselect', oldValue: [845140000], newValue: [845140000, INTEREST_KI_SERVICES] });
    expect(field(cs, 'decisionmaker')?.newValue).toBe(true);
    expect(cs.tasks).toEqual([]); // booking is the follow-up
  });

  it('Termin gebucht without decision maker leaves decisionmaker; interests already present → no op', () => {
    const cs = build('meeting_booked', {}, { lead: lead({ kls_interests: [INTEREST_KI_SERVICES] }) });
    expect(field(cs, 'decisionmaker')).toBeUndefined();
    expect(field(cs, 'kls_interests')).toBeUndefined();
  });

  it('3 Vorschläge: Termin vorgeschlagen, interests, follow-up after 3 working days', () => {
    const cs = build('proposals_sent');
    expect(field(cs, 'kls_callstatus')?.newValue).toBe(CALL_STATUS.MEETING_PROPOSED);
    expect(field(cs, 'kls_interests')?.newValue).toContain(INTEREST_KI_SERVICES);
    expect(formatZurich(cs.tasks[0].dueAt!, 'EEE dd.MM.')).toBe('Fri 20.11.');
  });

  it('Mail mit Infos: 845140008, rating «Potenzial» only with interest ≥ 2, task in 1 week', () => {
    const high = build('info_mail', { interest: 2 });
    expect(field(high, 'kls_callstatus')?.newValue).toBe(CALL_STATUS.WAITING);
    expect(field(high, 'kls_rating_category')?.newValue).toBe(RATING.POTENTIAL);
    expect(high.tasks[0].subject).toBe('Nachfassen Use-Case-Mail Muster AG');
    expect(high.activities[0].interest).toBe(2);
    const low = build('info_mail', { interest: 1 });
    expect(field(low, 'kls_rating_category')).toBeUndefined();
  });

  it('Später wieder melden: status by date, rating «Später», task on the named date', () => {
    const cs = build('later', { followUpAt: '2027-03-02T08:00:00Z' });
    expect(field(cs, 'kls_callstatus')?.newValue).toBe(CALL_STATUS.CALLBACK_3_6_MONTHS);
    expect(field(cs, 'kls_rating_category')?.newValue).toBe(RATING.LATER);
    expect(cs.tasks[0]).toMatchObject({ dueAt: '2027-03-02T08:00:00.000Z', taskType: 'follow_up' });
  });

  it('Kein Bedarf: Rückruf in 3–6 Monaten, rating, task in ~6 months', () => {
    const cs = build('no_need');
    expect(field(cs, 'kls_callstatus')?.newValue).toBe(CALL_STATUS.CALLBACK_3_6_MONTHS);
    expect(field(cs, 'kls_rating_category')?.newValue).toBe(RATING.NO_NEED_CURRENT);
    const months = (Date.parse(cs.tasks[0].dueAt!) - now.getTime()) / (30 * 86_400_000);
    expect(months).toBeGreaterThan(5.9);
  });

  it('Hat Partner: only the rating, no task; open tasks of the lead are closed (newest info wins)', () => {
    const cs = build('has_partner', {}, { openCompanyTasks: [task({ id: 'cb', leadId: 'lead-1' }), task({ id: 'other', leadId: 'lead-2' })] });
    expect(field(cs, 'kls_rating_category')?.newValue).toBe(RATING.NO_NEED_PARTNER);
    expect(field(cs, 'kls_callstatus')).toBeUndefined();
    expect(cs.tasks).toEqual([expect.objectContaining({ action: 'cancel', taskId: 'cb' })]);
    expect(cs.stateChanges).toEqual([]);
  });

  it('Intern / Konzern: note «Nicht qualifiziert – …» then disqualify 6', () => {
    const cs = build('internal_group', { reason: 'IT macht alles der Konzern in Deutschland' });
    expect(field(cs, 'kls_rating_category')?.newValue).toBe(RATING.NO_NEED_INTERNAL);
    expect(cs.notes).toHaveLength(1);
    expect(cs.notes[0].text).toBe('Sales-Portal: Nicht qualifiziert – intern / Konzern. IT macht alles der Konzern in Deutschland');
    expect(cs.stateChanges).toEqual([expect.objectContaining({ statecode: STATE.DISQUALIFIED, statuscode: STATUS.NO_LONGER_INTERESTED })]);
    // no Neu → Kontaktiert when the lead is closed anyway
    expect(field(cs, 'statuscode')).toBeUndefined();
    expect(cs.baseSnapshot[snapshotKey('lead', 'lead-1', 'statecode')]).toBe(0);
  });

  it('disqualifying requires the reason from the call', () => {
    expect(() => build('internal_group', {})).toThrow(/Grund aus dem Gespräch/);
    expect(() => build('competitor', { reason: ' ' })).toThrow(ResultInputError);
  });

  it('Zu klein (< 5 MA): employees, rating, note «zu klein», disqualify Ausserhalb ICP', () => {
    const cs = build('too_small', { employees: 3, reason: 'nur Inhaber und zwei Lernende' });
    expect(field(cs, 'numberofemployees')).toMatchObject({ oldValue: 60, newValue: 3 });
    expect(field(cs, 'kls_rating_category')?.newValue).toBe(RATING.TOO_SMALL);
    expect(cs.notes[0].text).toBe('Sales-Portal: Nicht qualifiziert – zu klein (3 MA). nur Inhaber und zwei Lernende');
    expect(cs.stateChanges[0].statuscode).toBe(STATUS.OUTSIDE_ICP);
  });

  it('Zu klein ab 5 MA: only rating + employees, lead stays open (Mindestgrösse-Regel)', () => {
    const cs = build('too_small', { employees: 8 });
    expect(field(cs, 'numberofemployees')?.newValue).toBe(8);
    expect(field(cs, 'kls_rating_category')?.newValue).toBe(RATING.TOO_SMALL);
    expect(cs.notes).toEqual([]);
    expect(cs.stateChanges).toEqual([]);
    expect(() => build('too_small', {})).toThrow(/Mitarbeitende/);
  });

  it('Nicht mehr kontaktieren: status, do-not flags, note, disqualify 6', () => {
    const cs = build('do_not_contact', { reason: 'will keine Anrufe mehr' });
    expect(field(cs, 'kls_callstatus')?.newValue).toBe(CALL_STATUS.DO_NOT_CONTACT);
    expect(field(cs, 'donotphone')?.newValue).toBe(true);
    expect(field(cs, 'donotemail')?.newValue).toBe(true);
    expect(field(cs, 'donotbulkemail')?.newValue).toBe(true);
    expect(cs.notes[0].text).toMatch(/^Sales-Portal: Nicht qualifiziert – möchte nicht mehr kontaktiert werden/);
    expect(cs.stateChanges[0]).toMatchObject({ statecode: 2, statuscode: STATUS.NO_LONGER_INTERESTED });
  });

  it('Mitbewerber: kls_competitor, disqualify Ausserhalb ICP; closes open tasks of the lead', () => {
    const cs = build('competitor', { reason: 'ist selbst IT-Dienstleister' }, { openCompanyTasks: [task({ id: 'cb' })] });
    expect(field(cs, 'kls_competitor')?.newValue).toBe(true);
    expect(cs.stateChanges[0].statuscode).toBe(STATUS.OUTSIDE_ICP);
    expect(cs.tasks).toEqual([expect.objectContaining({ action: 'cancel', taskId: 'cb' })]);
  });

  it('Falsche Person ohne neue Person: lead stays open, research task', () => {
    const cs = build('wrong_person', {});
    expect(cs.stateChanges).toEqual([]);
    expect(cs.tasks[0]).toMatchObject({ taskType: 'research', subject: 'Kontakt-Research Muster AG' });
  });

  it('Falsche Person mit neuer Person: new lead, old lead «Kontakt nicht möglich» after the note', () => {
    const cs = build('wrong_person', {
      reason: 'Frau Muster hat die Firma verlassen',
      newPerson: { firstname: 'Beat', lastname: 'Neu', jobtitle: 'CEO', email: 'Beat@Muster.example', phone: '079 555 66 77', samePerson: false },
    }, { companyOpenLeadCount: 2 });
    expect(cs.leadCreates).toHaveLength(1);
    expect(cs.leadCreates[0].fields).toMatchObject({
      companyname: 'Muster AG',
      firstname: 'Beat',
      lastname: 'Neu',
      emailaddress1: 'beat@muster.example',
      telephone1: '+41 79 555 66 77',
      ownerid: MARKUS,
      statuscode: STATUS.NEW,
      kls_leadscore: 75,
    });
    expect(cs.leadCreates[0].fields.kls_salutation).toBeUndefined(); // never guessed
    expect(cs.notes[0].text).toMatch(/^Sales-Portal: Kontakt nicht möglich/);
    expect(cs.stateChanges[0]).toMatchObject({ statecode: 2, statuscode: STATUS.CANNOT_CONTACT });
  });

  it('Falsche Nummer: corrected number in the uniform format, nobody reached → no owner/status change', () => {
    const cs = build('wrong_number', { correctedPhone: '0041 61 999 88 77' });
    expect(fieldNames(cs)).toEqual(['telephone1']);
    expect(field(cs, 'telephone1')?.newValue).toBe('+41 61 999 88 77');
    const mobile = build('wrong_number', { correctedPhone: '079 111 22 33', correctedPhoneField: 'mobilephone' });
    expect(fieldNames(mobile)).toEqual(['mobilephone']);
    expect(() => build('wrong_number', { correctedPhone: 'abc' })).toThrow(ResultInputError);
    expect(build('wrong_number', {}).operations).toEqual([]);
  });
});

describe('Andere Ansprechperson (6.8)', () => {
  it('same person with new address → lead is updated', () => {
    const cs = build('waiting', { newPerson: { firstname: 'Anna', lastname: 'Muster', email: 'a.muster@muster.example', samePerson: true } });
    expect(field(cs, 'emailaddress1')).toMatchObject({ oldValue: 'anna@muster.example', newValue: 'a.muster@muster.example' });
    expect(field(cs, 'firstname')).toBeUndefined(); // unchanged
    expect(cs.leadCreates).toEqual([]);
  });

  it('other person → new lead, previous lead becomes Zweitkontakt', () => {
    const cs = build('waiting', { newPerson: { firstname: 'Beat', lastname: 'Neu', salutation: 845140000, samePerson: false } }, { companyOpenLeadCount: 1 });
    expect(cs.leadCreates[0].fields).toMatchObject({ lastname: 'Neu', kls_salutation: 845140000, kls_callstatus: CALL_STATUS.WAITING });
    expect(field(cs, 'statuscode')).toMatchObject({ newValue: STATUS.SECOND_CONTACT });
  });

  it('max. 2 leads per company', () => {
    const input: ResultInput = { newPerson: { firstname: 'Beat', lastname: 'Neu', samePerson: false } };
    expect(() => build('waiting', input, { companyOpenLeadCount: 2 })).toThrow(/höchstens 2/);
    // wrong person closes the old lead → still 2
    expect(() => build('wrong_person', { ...input, reason: 'hat gewechselt' }, { companyOpenLeadCount: 2 })).not.toThrow();
  });

  it('validates the new person', () => {
    const issues = validateResultInput(rule('waiting'), lead(), { newPerson: { firstname: 'X', lastname: '', email: 'nope', phone: '12', samePerson: false } }, { now });
    expect(issues.map((i) => i.field)).toEqual(['newPerson.lastname', 'newPerson.email', 'newPerson.phone']);
  });

  it('ignored for «Nicht erreicht» (nobody reached)', () => {
    const cs = build('not_reached', { newPerson: { firstname: 'B', lastname: 'N', samePerson: false } });
    expect(cs.leadCreates).toEqual([]);
  });
});

describe('tasks via REGEL_AUFGABEN', () => {
  it('adapts the existing open company task instead of creating a second one', () => {
    const cs = build('waiting', {}, { openCompanyTasks: [task({ id: 'old', leadId: 'lead-2' })] });
    expect(cs.tasks).toHaveLength(1);
    expect(cs.tasks[0]).toMatchObject({ action: 'update', taskId: 'old' });
    expect(cs.tasks[0].ruleNote).toContain('neueste Info gewinnt');
    expect(cs.baseSnapshot[snapshotKey('task', 'old', 'scheduledend')]).toBe('2026-11-25T08:00:00Z');
  });

  it('shifts when the caller already has 3 tasks that day', () => {
    const full = [1, 2, 3].map((i) => task({ id: `f${i}`, leadId: `l${i}`, dueAt: '2026-11-24T07:00:00Z' }));
    const cs = build('waiting', {}, { ownerOpenTasks: full });
    expect(formatZurich(cs.tasks[0].dueAt!, 'dd.MM.')).toBe('25.11.');
    expect(cs.tasks[0].ruleNote).toContain('max. 3');
  });
});

describe('callStatusForDate', () => {
  const byDate = { mode: 'by_date' as const, byDate: CALLBACK_STATUS_BY_DATE };
  const at = (iso: string) => new Date(iso);
  it.each([
    ['2026-11-17T15:00:00Z', CALL_STATUS.CALLBACK_TODAY],
    ['2026-11-18T08:00:00Z', CALL_STATUS.CALLBACK_TOMORROW],
    ['2026-11-24T08:00:00Z', CALL_STATUS.CALLBACK_7_DAYS],
    ['2026-11-25T08:00:00Z', CALL_STATUS.CALLBACK_31_DAYS],
    ['2026-12-18T08:00:00Z', CALL_STATUS.CALLBACK_31_DAYS],
    ['2026-12-19T08:00:00Z', CALL_STATUS.CALLBACK_3_6_MONTHS],
  ])('%s → %s', (date, expected) => {
    expect(callStatusForDate(byDate, at(date), now)).toBe(expected);
  });
  it('uses Zurich calendar days (23:30 Zurich is still today)', () => {
    expect(callStatusForDate(byDate, at('2026-11-17T22:30:00Z'), now)).toBe(CALL_STATUS.CALLBACK_TODAY);
    expect(callStatusForDate(byDate, at('2026-11-17T23:30:00Z'), now)).toBe(CALL_STATUS.CALLBACK_TOMORROW);
  });
  it('fixed / none / missing date', () => {
    expect(callStatusForDate({ mode: 'fixed', value: 1 }, null, now)).toBe(1);
    expect(callStatusForDate({ mode: 'none' }, at('2026-11-18T08:00:00Z'), now)).toBeNull();
    expect(callStatusForDate(byDate, null, now)).toBeNull();
  });
});

describe('evaluateCondition', () => {
  it('handles every kind', () => {
    const l = lead({ numberofemployees: 4 });
    expect(evaluateCondition(undefined, l, {})).toBe(true);
    expect(evaluateCondition({ kind: 'interest_gte', value: 2 }, l, { interest: 3 })).toBe(true);
    expect(evaluateCondition({ kind: 'interest_gte', value: 2 }, l, {})).toBe(false);
    expect(evaluateCondition({ kind: 'employees_lt', value: 5 }, l, {})).toBe(true);
    expect(evaluateCondition({ kind: 'employees_lt', value: 5 }, l, { employees: 12 })).toBe(false);
    expect(evaluateCondition({ kind: 'employees_gte', value: 5 }, l, { employees: 12 })).toBe(true);
    expect(evaluateCondition({ kind: 'input_true', input: 'decisionMakerInMeeting' }, l, { decisionMakerInMeeting: true })).toBe(true);
    expect(evaluateCondition({ kind: 'input_present', input: 'correctedPhone' }, l, { correctedPhone: '' })).toBe(false);
    expect(evaluateCondition({ kind: 'input_absent', input: 'newPerson' }, l, {})).toBe(true);
  });
});

describe('conflict check (6.9)', () => {
  const cs = () => build('meeting_booked', { decisionMakerInMeeting: true });
  const nowValues = (draft: ReturnType<typeof cs>, overrides: Record<string, unknown> = {}) => {
    const out: Record<string, unknown> = {};
    for (const op of draft.operations) out[snapshotKey('lead', 'lead-1', op.field)] = op.oldValue;
    return { ...out, ...overrides };
  };

  it('no conflict when the CRM is unchanged', () => {
    const d = cs();
    expect(detectConflicts(d, nowValues(d))).toEqual([]);
  });

  it('shows Entwurf · CRM jetzt · neu when someone changed a field meanwhile', () => {
    const d = cs();
    const conflicts = detectConflicts(d, nowValues(d, { [snapshotKey('lead', 'lead-1', 'subject')]: 'Offerte ERP' }));
    expect(conflicts).toEqual([expect.objectContaining({ field: 'subject', draftValue: null, crmNow: 'Offerte ERP', newValue: 'KI Termin', resolution: null })]);
  });

  it('multiselect additions never conflict; equal new value is no conflict', () => {
    const d = cs();
    expect(
      detectConflicts(d, nowValues(d, { [snapshotKey('lead', 'lead-1', 'kls_interests')]: [1, 2], [snapshotKey('lead', 'lead-1', 'subject')]: 'KI Termin' })),
    ).toEqual([]);
  });

  it('state change conflicts when the lead was closed meanwhile', () => {
    const d = build('competitor', { reason: 'IT-Firma' });
    const conflicts = detectConflicts(d, { [snapshotKey('lead', 'lead-1', 'statecode')]: 1, [snapshotKey('lead', 'lead-1', 'statuscode')]: 3 });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].opId).toBe(d.stateChanges[0].id);
  });

  it('push only after a decision per field; keep_crm drops the op', () => {
    const d = cs();
    const conflicts = detectConflicts(d, nowValues(d, { [snapshotKey('lead', 'lead-1', 'subject')]: 'Offerte ERP' }));
    expect(resolveConflicts(d, conflicts, {}).ok).toBe(false);
    const kept = resolveConflicts(d, conflicts, { [conflicts[0].opId]: 'keep_crm' });
    expect(kept.ok && kept.changeSet.operations.some((o) => o.field === 'subject')).toBe(false);
    const over = resolveConflicts(d, conflicts, { [conflicts[0].opId]: 'overwrite' });
    expect(over.ok && over.changeSet.operations.some((o) => o.field === 'subject')).toBe(true);
  });

  it('lists the fields to re-read per record', () => {
    const d = build('competitor', { reason: 'IT-Firma' });
    expect(fieldsToReread(d)).toEqual([{ entity: 'lead', id: 'lead-1', fields: expect.arrayContaining(['kls_competitor', 'ownerid', 'statecode', 'statuscode']) }]);
  });
});

describe('revert and retry', () => {
  it('undoes «Nicht erreicht»: call status back, created call cancelled', () => {
    const d = build('not_reached');
    const pushed = {
      ...d,
      id: 'cs-1',
      results: [
        { opId: d.activities[0].id, kind: 'activity' as const, ok: true, createdId: 'pc-9' },
        { opId: d.operations[0].id, kind: 'field' as const, ok: true },
      ],
    };
    const plan = buildRevertDraft(pushed, { [snapshotKey('lead', 'lead-1', 'kls_callstatus')]: CALL_STATUS.NOT_REACHED });
    expect(plan.skipped).toEqual([]);
    expect(plan.draft.operations).toEqual([expect.objectContaining({ field: 'kls_callstatus', oldValue: CALL_STATUS.NOT_REACHED, newValue: null })]);
    expect(plan.draft.activities).toEqual([expect.objectContaining({ action: 'update', activityId: 'pc-9', statecode: 2 })]);
    expect(plan.draft.notes).toEqual([]);
  });

  it('never overwrites a field changed after the push; restores state and cancels created tasks', () => {
    const d = build('competitor', { reason: 'IT-Firma' }, { openCompanyTasks: [] });
    const pushed = { ...d, id: 'cs-2', results: [...d.operations, ...d.stateChanges, ...d.notes].map((o) => ({ opId: o.id, kind: 'field' as const, ok: true })) };
    const crmNow = { [snapshotKey('lead', 'lead-1', 'kls_competitor')]: false, [snapshotKey('lead', 'lead-1', 'ownerid')]: MARKUS };
    const plan = buildRevertDraft(pushed, crmNow);
    expect(plan.skipped.map((s) => s.field)).toEqual(['kls_competitor']);
    expect(plan.draft.operations.map((o) => o.field)).toEqual(['ownerid']);
    expect(plan.draft.stateChanges[0]).toMatchObject({ statecode: 0, statuscode: STATUS.NEW });
    expect(plan.draft.notes[0].text).toMatch(/^Sales-Portal: Änderungen zurückgesetzt/);
  });

  it('retry pushes only what failed before', () => {
    const d = build('waiting');
    const part = pendingPart(d, [{ opId: d.activities[0].id, kind: 'activity', ok: true }, { opId: d.operations[0].id, kind: 'field', ok: false, error: 'x' }]);
    expect(part.activities).toEqual([]);
    expect(part.operations).toHaveLength(d.operations.length);
  });
});

describe('wrap-up helpers', () => {
  it('shortcuts: admin keys win, reserved / duplicate keys are dropped, groups without key get a free fallback', () => {
    const map = resultGroupShortcuts(DEFAULT_RESULT_GROUP_RULES);
    // The defaults n / v / k are usable again (the dial / list keys are not active while the panel is shown).
    expect(map.get('not_reached')).toBe('n');
    expect(map.get('proposals_sent')).toBe('v');
    expect(map.get('no_need')).toBe('k');
    // Every default group has a key, all keys are unique and none is reserved.
    for (const r of DEFAULT_RESULT_GROUP_RULES) expect(map.get(r.key), r.key).toBeTruthy();
    const keys = [...map.values()];
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(RESULT_SHORTCUT_RESERVED).not.toContain(k);

    const custom = resultGroupShortcuts([
      { key: 'callback', shortcut: 'e' },
      { key: 'waiting', shortcut: 'W' },
      { key: 'later', shortcut: 'w' },
      { key: 'internal_group', shortcut: 'w' },
    ]);
    expect(custom.get('callback')).toBeUndefined(); // «E» is Aufgelegt / Ergebnis
    expect(custom.get('waiting')).toBe('w');
    expect(custom.get('later')).toBeUndefined(); // taken twice, no fallback for «later»
    expect(custom.get('internal_group')).toBe('i'); // fallback
  });

  it('follow-up requirement: Termin gebucht needs a booking, Vorschläge / Mail the sent mail', () => {
    const rule = (k: ResultGroupKey) => DEFAULT_RESULT_GROUP_RULES.find((r) => r.key === k)!;
    expect(followUpRequirement(rule('meeting_booked'))).toBe('booking');
    expect(followUpRequirement(rule('proposals_sent'))).toBe('proposals');
    expect(followUpRequirement(rule('info_mail'))).toBe('mail');
    expect(followUpRequirement(rule('waiting'))).toBeNull();
    expect(followUpRequirement(null)).toBeNull();

    const since = '2026-11-17T09:00:00Z';
    const proposals = { kind: 'mail' as const, ruleKey: 'proposals_sent' as const, createdAt: '2026-11-17T09:05:00Z', status: 'draft' as const };
    const useCaseMail = { kind: 'mail' as const, ruleKey: null, createdAt: '2026-11-17T09:06:00Z', status: 'pushed' as const };
    const old = { ...useCaseMail, createdAt: '2026-11-10T09:00:00Z' };
    expect(followUpMailSent([proposals], 'proposals', since, now)).toBe(true);
    expect(followUpMailSent([proposals], 'mail', since, now)).toBe(false);
    expect(followUpMailSent([useCaseMail], 'mail', since, now)).toBe(true);
    expect(followUpMailSent([old], 'mail', since, now)).toBe(false);
    expect(followUpMailSent([{ ...useCaseMail, status: 'discarded' as const }], 'mail', since, now)).toBe(false);
    // Without call start: the last 12 hours.
    expect(followUpMailSent([{ ...useCaseMail, createdAt: '2026-11-17T01:00:00Z' }], 'mail', null, now)).toBe(true);
    expect(followUpMailSent([{ ...useCaseMail, createdAt: '2026-11-16T08:00:00Z' }], 'mail', null, now)).toBe(false);
  });
});
