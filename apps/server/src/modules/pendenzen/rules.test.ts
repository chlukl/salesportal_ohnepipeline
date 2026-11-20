import { zurichTime, type PendenzEntry } from '@sales-portal/shared';
import { describe, expect, it } from 'vitest';
import {
  applyFilter,
  canReplanBookings,
  cancellationTarget,
  classifyDue,
  countsForHeader,
  deriveOrigin,
  isUnfinishedCall,
  scopeForRoles,
  sortPendenzen,
  startOfNextZurichWeek,
  type SessionLike,
} from './rules';

// Wednesday 18.11.2026, 10:00 Zurich.
const NOW = zurichTime('2026-11-18', '10:00');

describe('classifyDue (Fälligkeit, Europe/Zurich)', () => {
  it('buckets by Zurich calendar day', () => {
    expect(classifyDue(null, NOW)).toBe('none');
    expect(classifyDue(zurichTime('2026-11-17', '23:59'), NOW)).toBe('overdue');
    expect(classifyDue(zurichTime('2026-11-18', '00:00'), NOW)).toBe('today');
    expect(classifyDue(zurichTime('2026-11-18', '08:00'), NOW)).toBe('today'); // earlier today is still «heute»
    expect(classifyDue(zurichTime('2026-11-18', '23:30'), NOW)).toBe('today');
    expect(classifyDue(zurichTime('2026-11-19', '09:00'), NOW)).toBe('this_week');
    expect(classifyDue(zurichTime('2026-11-22', '20:00'), NOW)).toBe('this_week'); // Sunday
    expect(classifyDue(zurichTime('2026-11-23', '00:00'), NOW)).toBe('later'); // next Monday
  });

  it('handles late-evening UTC offsets (23:30 Zurich is still the same day)', () => {
    const lateNow = zurichTime('2026-11-18', '23:30');
    expect(classifyDue(zurichTime('2026-11-18', '07:00'), lateNow)).toBe('today');
    expect(classifyDue(zurichTime('2026-11-19', '00:10'), lateNow)).toBe('this_week');
  });

  it('on Sunday there is no «diese Woche» after today', () => {
    const sunday = zurichTime('2026-11-22', '12:00');
    expect(startOfNextZurichWeek(sunday).toISOString()).toBe(zurichTime('2026-11-23', '00:00').toISOString());
    expect(classifyDue(zurichTime('2026-11-23', '09:00'), sunday)).toBe('later');
  });

  it('ignores invalid dates', () => {
    expect(classifyDue('kein Datum', NOW)).toBe('none');
  });
});

describe('deriveOrigin (Herkunft)', () => {
  it('booking origin wins, then campaign lead, then coldcall process', () => {
    expect(deriveOrigin({ kind: 'booking', bookingOrigin: 'campaign', leadFromCampaign: false })).toBe('campaign');
    expect(deriveOrigin({ kind: 'task', leadFromCampaign: true })).toBe('campaign');
    expect(deriveOrigin({ kind: 'unfinished_call' })).toBe('coldcall');
    expect(deriveOrigin({ kind: 'task', fromColdcall: true })).toBe('coldcall');
    expect(deriveOrigin({ kind: 'task' })).toBe('other');
    expect(deriveOrigin({ kind: 'campaign_reply' })).toBe('campaign');
  });
});

describe('isUnfinishedCall (kein Anruf bleibt ohne CRM-Eintrag)', () => {
  const base: SessionLike = {
    id: 's1',
    direction: 'outbound',
    category: 'outbound',
    status: 'ended',
    resultGroup: null,
    crmPhonecallId: null,
    changeSetId: null,
  };
  it('call without result is unfinished', () => {
    expect(isUnfinishedCall(base, null)).toBe(true);
    expect(isUnfinishedCall({ ...base, status: 'connected' }, null)).toBe(true);
  });
  it('result chosen but change set not pushed is unfinished', () => {
    expect(isUnfinishedCall({ ...base, resultGroup: 'callback', changeSetId: 'cs' }, 'pending')).toBe(true);
    expect(isUnfinishedCall({ ...base, resultGroup: 'callback', changeSetId: 'cs' }, 'failed')).toBe(true);
  });
  it('pushed / CRM phone call / abandoned / discarded are finished', () => {
    expect(isUnfinishedCall({ ...base, resultGroup: 'callback', changeSetId: 'cs' }, 'pushed')).toBe(false);
    expect(isUnfinishedCall({ ...base, crmPhonecallId: 'pc' }, null)).toBe(false);
    expect(isUnfinishedCall({ ...base, status: 'abandoned' }, null)).toBe(false);
    expect(isUnfinishedCall({ ...base, changeSetId: 'cs' }, 'discarded')).toBe(false);
  });
  it('missed callbacks and unknown numbers belong to the history, not the Pendenzen', () => {
    expect(isUnfinishedCall({ ...base, direction: 'inbound', category: 'callback_missed' }, null)).toBe(false);
    expect(isUnfinishedCall({ ...base, direction: 'inbound', category: 'unknown_number' }, null)).toBe(false);
  });
  it('an answered callback without result is unfinished', () => {
    expect(isUnfinishedCall({ ...base, direction: 'inbound', category: 'callback_answered', status: 'connected' }, null)).toBe(true);
  });
});

function entry(partial: Partial<PendenzEntry> & Pick<PendenzEntry, 'id' | 'kind'>): PendenzEntry {
  return {
    title: partial.id,
    subtitle: null,
    dueAt: null,
    due: 'none',
    ownerUserId: null,
    ownerName: null,
    leadId: null,
    companyName: null,
    origin: 'other',
    status: 'open',
    ref: { type: 'x', id: partial.id },
    link: null,
    statusLabel: null,
    tone: 'neutral',
    actions: [],
    taskType: null,
    snoozedUntil: null,
    ...partial,
  };
}

describe('sortPendenzen', () => {
  const items = [
    entry({ id: 'booking', kind: 'booking', due: 'today', dueAt: '2026-11-18T13:00:00Z' }),
    entry({ id: 'task-later', kind: 'task', due: 'later', dueAt: '2026-12-01T09:00:00Z', taskType: 'follow_up' }),
    entry({ id: 'followup-today', kind: 'task', due: 'today', dueAt: '2026-11-18T08:00:00Z', taskType: 'follow_up' }),
    entry({ id: 'callback-overdue', kind: 'task', due: 'overdue', dueAt: '2026-11-16T08:00:00Z', taskType: 'callback' }),
    entry({ id: 'approval', kind: 'approval' }),
    entry({ id: 'call', kind: 'unfinished_call', due: 'today', dueAt: '2026-11-18T07:00:00Z' }),
    entry({ id: 'done', kind: 'task', status: 'done', due: 'overdue', taskType: 'callback' }),
  ];

  it('coldcaller: unfinished calls, due callbacks and due tasks on top; done last', () => {
    const order = sortPendenzen(items, true).map((i) => i.id);
    expect(order.slice(0, 3)).toEqual(['call', 'callback-overdue', 'followup-today']);
    expect(order.at(-1)).toBe('done');
    expect(order.indexOf('approval')).toBeLessThan(order.indexOf('task-later'));
  });

  it('others: by due date (overdue, today, none, this week, later)', () => {
    const order = sortPendenzen(items.filter((i) => i.kind !== 'unfinished_call'), false).map((i) => i.id);
    expect(order[0]).toBe('callback-overdue');
    expect(order.indexOf('followup-today')).toBeLessThan(order.indexOf('booking'));
    expect(order.indexOf('booking')).toBeLessThan(order.indexOf('task-later'));
  });
});

describe('applyFilter', () => {
  const items = [
    entry({ id: 'a', kind: 'task', due: 'overdue', origin: 'coldcall', companyName: 'Alpha AG' }),
    entry({ id: 'b', kind: 'task', due: 'later', origin: 'campaign', companyName: 'Beta GmbH' }),
    entry({ id: 'c', kind: 'booking', due: 'today', origin: 'campaign', companyName: 'Beta GmbH' }),
    entry({ id: 'd', kind: 'briefing', status: 'done', due: 'today', companyName: 'Beta GmbH' }),
  ];
  it('filters by Art and keeps counts of the other kinds', () => {
    const r = applyFilter(items, { kinds: ['task'] });
    expect(r.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(r.counts.booking).toBe(1);
    expect(r.counts.task).toBe(2);
    expect(r.counts.briefing).toBe(0); // done, default status open
  });
  it('filters by Fälligkeit, Herkunft, Firma, Status', () => {
    expect(applyFilter(items, { due: ['overdue', 'today'] }).items.map((i) => i.id)).toEqual(['a', 'c']);
    expect(applyFilter(items, { origins: ['campaign'] }).items.map((i) => i.id)).toEqual(['b', 'c']);
    expect(applyFilter(items, { company: 'beta' }).items.map((i) => i.id)).toEqual(['b', 'c']);
    expect(applyFilter(items, { status: 'done' }).items.map((i) => i.id)).toEqual(['d']);
    expect(applyFilter(items, { status: 'all' }).items).toHaveLength(4);
  });
});

describe('scopeForRoles', () => {
  it('maps roles to sources (INTENT 3)', () => {
    expect(scopeForRoles(['coldcaller'])).toMatchObject({ coldcall: true, salesBookings: false, allBookings: false, allErrors: false });
    expect(scopeForRoles(['sales'])).toMatchObject({ coldcall: false, salesBookings: true, allBookings: false });
    expect(scopeForRoles(['ai_specialist'])).toMatchObject({ allBookings: true, coldcall: false });
    expect(scopeForRoles(['admin'])).toMatchObject({ allErrors: true, coldcall: false });
    expect(scopeForRoles([]).tasks).toBe(false);
  });
});

describe('countsForHeader', () => {
  it('counts open items due now or without date, not analyses or appointments', () => {
    const n = countsForHeader([
      entry({ id: '1', kind: 'task', due: 'overdue' }),
      entry({ id: '2', kind: 'task', due: 'later' }),
      entry({ id: '3', kind: 'approval', due: 'none' }),
      entry({ id: '4', kind: 'analysis', due: 'none' }),
      entry({ id: '5', kind: 'booking', due: 'today' }),
      entry({ id: '6', kind: 'task', due: 'today', status: 'done' }),
    ]);
    expect(n).toBe(2);
  });
});

describe('cancellation Pendenz («Termin abgesagt – neu planen»)', () => {
  it('only coldcaller / admin can re-plan (same roles as booking)', () => {
    expect(canReplanBookings(['coldcaller'])).toBe(true);
    expect(canReplanBookings(['admin'])).toBe(true);
    expect(canReplanBookings(['sales'])).toBe(false);
    expect(canReplanBookings(['ai_specialist'])).toBe(false);
    expect(canReplanBookings([])).toBe(false);
  });

  it('links straight into the Termin tab when re-planning is possible, else just to the lead', () => {
    expect(cancellationTarget({ leadId: 'L1', cancelled: true, canReplan: true })).toEqual({ link: '/lead/L1?panel=scheduling', replan: true });
    expect(cancellationTarget({ leadId: 'L1', cancelled: true, canReplan: false })).toEqual({ link: '/lead/L1', replan: false });
    // A moved meeting needs no re-planning.
    expect(cancellationTarget({ leadId: 'L1', cancelled: false, canReplan: true })).toEqual({ link: '/lead/L1', replan: false });
  });
});
