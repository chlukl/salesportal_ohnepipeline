import { describe, expect, it } from 'vitest';
import { RESULT_GROUP_CODES } from './i18n';
import { addWorkdays, applyTaskRules, earliestNewAttempt, halfDayStart, isWorkday, nextAttemptAfterNotReached, type TaskProposal } from './taskRules';
import { formatZurich } from './time';
import type { CrmTask } from './types';

const MARKUS = 'crm-markus';
// Tuesday 17.11.2026, 10:00 Zurich (09:00Z)
const now = new Date('2026-11-17T09:00:00Z');

function task(p: Partial<CrmTask>): CrmTask {
  return {
    id: p.id ?? `t-${Math.random().toString(36).slice(2, 8)}`,
    leadId: 'lead-1',
    leadName: null,
    companyName: 'Muster AG',
    subject: 'Aufgabe',
    description: null,
    dueAt: '2026-11-18T08:00:00Z',
    ownerId: MARKUS,
    ownerName: 'Markus',
    statecode: 0,
    taskType: 'follow_up',
    createdon: '2026-11-01T08:00:00Z',
    completedon: null,
    ...p,
  };
}

function proposal(p: Partial<TaskProposal> = {}): TaskProposal {
  return { leadId: 'lead-1', subject: 'Nachfassen Muster AG', dueAt: '2026-11-19T08:00:00Z', ownerId: MARKUS, taskType: 'follow_up', ...p };
}

const ctx = (p: Partial<Parameters<typeof applyTaskRules>[1]> = {}) => ({
  openCompanyTasks: [],
  ownerOpenTasks: [],
  maxPerPersonPerDay: 3,
  now,
  ...p,
});

describe('working days', () => {
  it('adds working days and skips weekends, keeping the local time', () => {
    const friday = new Date('2026-11-20T08:00:00Z'); // Fr 09:00
    expect(formatZurich(addWorkdays(friday, 1), 'EEE dd.MM. HH:mm')).toBe('Mon 23.11. 09:00');
    expect(formatZurich(addWorkdays(friday, 3), 'EEE dd.MM.')).toBe('Wed 25.11.');
    expect(formatZurich(addWorkdays(now, 3), 'EEE dd.MM.')).toBe('Fri 20.11.');
  });
  it('0 days moves a weekend date to Monday, keeps a working day', () => {
    expect(formatZurich(addWorkdays(new Date('2026-11-21T10:00:00Z'), 0), 'EEE dd.MM.')).toBe('Mon 23.11.');
    expect(formatZurich(addWorkdays(now, 0), 'EEE dd.MM.')).toBe('Tue 17.11.');
    expect(isWorkday(new Date('2026-11-22T10:00:00Z'))).toBe(false);
  });
  it('keeps the wall-clock time across the DST change', () => {
    const fri = new Date('2026-03-27T08:00:00Z'); // Fr 09:00 CET
    expect(formatZurich(addWorkdays(fri, 1), 'dd.MM. HH:mm')).toBe('30.03. 09:00'); // Mo 09:00 CEST
  });
});

describe('next attempt after «Nicht erreicht» (never the same half-day)', () => {
  it('morning → same day 13:00', () => {
    expect(formatZurich(nextAttemptAfterNotReached(now), 'dd.MM. HH:mm')).toBe('17.11. 13:00');
  });
  it('afternoon → next working day 08:00', () => {
    expect(formatZurich(nextAttemptAfterNotReached(new Date('2026-11-17T14:00:00Z')), 'dd.MM. HH:mm')).toBe('18.11. 08:00');
    expect(formatZurich(nextAttemptAfterNotReached(new Date('2026-11-20T14:00:00Z')), 'EEE dd.MM. HH:mm')).toBe('Mon 23.11. 08:00');
  });
  it('half-day start', () => {
    expect(formatZurich(halfDayStart(now), 'HH:mm')).toBe('00:00');
    expect(formatZurich(halfDayStart(new Date('2026-11-17T12:30:00Z')), 'HH:mm')).toBe('12:00');
  });
});

describe('applyTaskRules (REGEL_AUFGABEN)', () => {
  it('creates a new task when the company has none', () => {
    const d = applyTaskRules(proposal(), ctx());
    expect(d.op?.action).toBe('create');
    expect(d.op?.dueAt).toBe('2026-11-19T08:00:00.000Z');
    expect(d.note).toBeNull();
  });

  it('newest info wins: adapts the existing open task of the company instead of creating a second one', () => {
    const existing = task({ id: 'old', leadId: 'lead-2', subject: 'Alt', dueAt: '2026-12-01T08:00:00Z', createdon: '2026-11-12T08:00:00Z' });
    const d = applyTaskRules(proposal(), ctx({ openCompanyTasks: [existing] }));
    expect(d.op).toMatchObject({ action: 'update', taskId: 'old', subject: 'Nachfassen Muster AG', dueAt: '2026-11-19T08:00:00.000Z' });
    expect(d.note).toContain('bestehende Aufgabe vom 12.11.2026 angepasst');
  });

  it('prefers the open task of the same lead, then the newest', () => {
    const a = task({ id: 'a', leadId: 'lead-2', createdon: '2026-11-15T08:00:00Z' });
    const b = task({ id: 'b', leadId: 'lead-1', createdon: '2026-11-01T08:00:00Z' });
    expect(applyTaskRules(proposal(), ctx({ openCompanyTasks: [a, b] })).op?.taskId).toBe('b');
    const c = task({ id: 'c', leadId: 'lead-3', createdon: '2026-11-16T08:00:00Z' });
    expect(applyTaskRules(proposal({ leadId: 'lead-9' }), ctx({ openCompanyTasks: [a, c] })).op?.taskId).toBe('c');
  });

  it('ignores completed tasks of the company', () => {
    const done = task({ id: 'done', statecode: 1 });
    expect(applyTaskRules(proposal(), ctx({ openCompanyTasks: [done] })).op?.action).toBe('create');
  });

  it('mentions when the task is taken over from another owner', () => {
    const manuel = task({ id: 'm', ownerId: 'crm-manuel', ownerName: 'Manuel' });
    expect(applyTaskRules(proposal(), ctx({ openCompanyTasks: [manuel] })).note).toContain('übernimmt die Aufgabe von Manuel');
  });

  it('max. 3 per person and day → shifts to the next working day', () => {
    const full = [1, 2, 3].map((i) => task({ id: `x${i}`, leadId: `other-${i}`, dueAt: '2026-11-19T07:00:00Z' }));
    const d = applyTaskRules(proposal(), ctx({ ownerOpenTasks: full }));
    expect(formatZurich(d.op!.dueAt!, 'dd.MM. HH:mm')).toBe('20.11. 09:00');
    expect(d.note).toContain('max. 3 Aufgaben pro Tag – auf 20.11.2026 verschoben');
  });

  it('shifts over a full Friday to Monday', () => {
    const fri = [1, 2, 3].map((i) => task({ id: `f${i}`, dueAt: '2026-11-20T09:00:00Z' }));
    const d = applyTaskRules(proposal({ dueAt: '2026-11-20T08:00:00Z' }), ctx({ ownerOpenTasks: fri }));
    expect(formatZurich(d.op!.dueAt!, 'EEE dd.MM.')).toBe('Mon 23.11.');
  });

  it('only counts open tasks of the same owner on that day and respects the setting', () => {
    const other = [1, 2, 3].map((i) => task({ id: `o${i}`, ownerId: 'crm-manuel', dueAt: '2026-11-19T07:00:00Z' }));
    const two = [1, 2].map((i) => task({ id: `t${i}`, dueAt: '2026-11-19T07:00:00Z' }));
    expect(applyTaskRules(proposal(), ctx({ ownerOpenTasks: [...other, ...two] })).note).toBeNull();
    expect(applyTaskRules(proposal(), ctx({ ownerOpenTasks: two, maxPerPersonPerDay: 2 })).note).toContain('max. 2');
  });

  it('the adapted task itself does not count for the limit', () => {
    const existing = task({ id: 'e', dueAt: '2026-11-19T07:00:00Z' });
    const two = [1, 2].map((i) => task({ id: `t${i}`, dueAt: '2026-11-19T07:00:00Z' }));
    const d = applyTaskRules(proposal(), ctx({ openCompanyTasks: [existing], ownerOpenTasks: [existing, ...two] }));
    expect(d.op?.dueAt).toBe('2026-11-19T08:00:00.000Z');
  });

  it('never puts a generated task on a weekend', () => {
    const d = applyTaskRules(proposal({ dueAt: '2026-11-21T08:00:00Z' }), ctx());
    expect(formatZurich(d.op!.dueAt!, 'EEE dd.MM.')).toBe('Mon 23.11.');
    expect(d.note).toContain('Wochenende');
  });

  it('an agreed callback date is never moved, only flagged', () => {
    const full = [1, 2, 3].map((i) => task({ id: `x${i}`, dueAt: '2026-11-19T07:00:00Z' }));
    const d = applyTaskRules(proposal({ taskType: 'callback', fixedDate: true, dueAt: '2026-11-19T13:30:00Z' }), ctx({ ownerOpenTasks: full }));
    expect(d.op?.dueAt).toBe('2026-11-19T13:30:00.000Z');
    expect(d.note).toContain('vereinbarter Rückruf bleibt');
  });
});

describe('earliestNewAttempt', () => {
  it('Kein Bedarf → 3 Monate, Hat Partner → 6 Monate, sonst keine Sperre', () => {
    expect(formatZurich(earliestNewAttempt(RESULT_GROUP_CODES.no_need, '2026-11-17T09:00:00Z')!, 'dd.MM.yyyy')).toBe('17.02.2027');
    expect(formatZurich(earliestNewAttempt(RESULT_GROUP_CODES.has_partner, '2026-11-17T09:00:00Z')!, 'dd.MM.yyyy')).toBe('17.05.2027');
    expect(earliestNewAttempt(RESULT_GROUP_CODES.callback, '2026-11-17T09:00:00Z')).toBeNull();
    expect(earliestNewAttempt(null, null)).toBeNull();
  });
});
