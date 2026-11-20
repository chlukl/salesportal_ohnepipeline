import { describe, expect, it } from 'vitest';
import { CALL_STATUS, INTEREST_KI_SERVICES, LEAD_SUPPORT, STATUS } from './i18n';
import { DEFAULT_RESULT_GROUP_RULES } from './resultGroupDefaults';
import {
  addWorkingDays,
  atLocalTime,
  buildCallStatusChangeSet,
  buildSchedulingChangeSet,
  checkAttendeeEmail,
  fillTemplate,
  findSlots,
  findSlotsFor,
  formatProposalsText,
  formatSlot,
  halfOfDay,
  isAllowedStart,
  isoWeek,
  isSlotFree,
  localHhmm,
  localIsoDate,
  monthThird,
  participantsFor,
  personPlaceholders,
  proposeThree,
  selectableMonths,
  swapProposal,
  weekdayOfIso,
  workWeekDays,
} from './scheduling';
import type { Actor, BookingRules, BusyInterval, MailboxSchedule, Proposal, ProposalRequest, Slot } from './types';

const MANUEL = 'manuel@kallysoft.example';
const NICO = 'nico@kallysoft.example';
const LUKAS = 'lukas@kallysoft.example';

const RULES: BookingRules = {
  startWindows: [
    { from: '09:00', to: '11:30' },
    { from: '14:00', to: '16:00' },
  ],
  blockedWindows: [{ from: '12:30', to: '14:00' }],
  durationMinutes: 30,
  bufferBeforeMinutes: 30,
  bufferAfterMinutes: 30,
  slotStepMinutes: 30,
  defaultSalesEmail: MANUEL,
  specialistEmail: NICO,
  extraCallSalesEmail: LUKAS,
  subjectTemplate: 'Vorstellung der Kallysoft Informatik AG als KI-Spezialist – {Firma}',
  outlookCategory: 'Kallysoft Erstgespräch',
  briefingCategory: 'Kallysoft Briefing',
  briefingMailDaysBefore: 7,
  timezone: 'Europe/Zurich',
};

const z = (date: string, hhmm: string) => atLocalTime(date, hhmm);
const busy = (date: string, from: string, to: string, status: BusyInterval['status'] = 'busy'): BusyInterval => ({
  start: z(date, from).toISOString(),
  end: z(date, to).toISOString(),
  status,
});
const sched = (email: string, intervals: BusyInterval[] = [], error: string | null = null): MailboxSchedule => ({ email, busy: intervals, error });
const allFree = () => [sched(MANUEL), sched(NICO), sched(LUKAS)];
const times = (slots: Slot[]) => slots.map((s) => localHhmm(s.start));

/** Slots of one local day with the standard pair. */
function daySlots(date: string, schedules: MailboxSchedule[], now = z('2026-11-01', '08:00'), extraCall = false): Slot[] {
  return findSlotsFor({ from: z(date, '00:00'), to: z(date, '23:59'), schedules, rules: RULES, now, extraCall });
}

// 2026-11-20 is a Friday; 2026-11-24 a Tuesday.
const NOW = z('2026-11-20', '10:15');

describe('calendar helpers', () => {
  it('knows weekdays and ISO weeks', () => {
    expect(weekdayOfIso('2026-11-20')).toBe(5);
    expect(weekdayOfIso('2026-12-01')).toBe(2);
    expect(isoWeek('2026-11-24')).toEqual({ year: 2026, week: 48 });
    expect(isoWeek('2027-01-01')).toEqual({ year: 2026, week: 53 });
    expect(workWeekDays('2026-11-25')).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']);
  });

  it('adds working days (Mon–Fri) keeping the wall clock', () => {
    const due = addWorkingDays(z('2026-11-20', '10:15'), 3);
    expect(localIsoDate(due)).toBe('2026-11-25');
    expect(localHhmm(due)).toBe('10:15');
    // across the DST switch (25.10.2026)
    expect(localHhmm(addWorkingDays(z('2026-10-23', '09:00'), 1))).toBe('09:00');
  });
});

describe('findSlots – windows', () => {
  it('offers 09:00–11:30 and 14:00–16:00 every 30 min on an empty day, nothing 12:30–14:00', () => {
    expect(times(daySlots('2026-11-24', allFree()))).toEqual([
      '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '14:00', '14:30', '15:00', '15:30', '16:00',
    ]);
  });

  it('offers nothing on weekends', () => {
    expect(daySlots('2026-11-21', allFree())).toEqual([]);
    expect(daySlots('2026-11-22', allFree())).toEqual([]);
  });

  it('marks the internal attendees on every slot', () => {
    const [slot] = daySlots('2026-11-24', allFree());
    expect(slot.attendees.sort()).toEqual([MANUEL, NICO].sort());
    expect(new Date(slot.end).getTime() - new Date(slot.start).getTime()).toBe(30 * 60_000);
  });

  it('respects the lead time (no slot with its preparation buffer already started)', () => {
    const slots = findSlotsFor({ from: z('2026-11-24', '00:00'), to: z('2026-11-24', '23:59'), schedules: allFree(), rules: RULES, now: z('2026-11-24', '09:10'), extraCall: false });
    expect(times(slots)[0]).toBe('10:00');
  });

  it('only returns starts within [from, to)', () => {
    const slots = findSlots({ from: z('2026-11-24', '10:00'), to: z('2026-11-24', '14:30'), schedules: allFree(), requiredAttendees: [MANUEL, NICO], rules: RULES, now: NOW });
    expect(times(slots)).toEqual(['10:00', '10:30', '11:00', '11:30', '14:00']);
  });
});

describe('findSlots – buffers for everybody at every start time', () => {
  it('needs 30 min free BEFORE 09:00 (old Terminplaner exception is not copied)', () => {
    const s = daySlots('2026-11-24', [sched(MANUEL), sched(NICO, [busy('2026-11-24', '08:30', '09:00')])]);
    expect(times(s)).not.toContain('09:00');
    expect(times(s)).toContain('09:30');
  });

  it('needs 30 min free BEFORE 14:00', () => {
    const s = daySlots('2026-11-24', [sched(MANUEL, [busy('2026-11-24', '13:00', '13:45')]), sched(NICO)]);
    expect(times(s)).not.toContain('14:00');
    expect(times(s)).toContain('14:30');
  });

  it('needs 30 min free AFTER the meeting', () => {
    const s = daySlots('2026-11-24', [sched(MANUEL), sched(NICO, [busy('2026-11-24', '11:00', '11:30')])]);
    expect(times(s)).toContain('10:00'); // 10:00–10:30, buffer until 11:00 → ok
    expect(times(s)).not.toContain('10:30'); // buffer 11:00–11:30 busy
    expect(times(s)).not.toContain('11:00');
    expect(times(s)).not.toContain('11:30'); // buffer before 11:00–11:30 busy
  });

  it('needs 30 min free after 16:00', () => {
    const s = daySlots('2026-11-24', [sched(MANUEL, [busy('2026-11-24', '16:45', '17:30')]), sched(NICO)]);
    expect(times(s)).not.toContain('16:00');
    expect(times(s)).toContain('15:30'); // buffer until 16:30
  });

  it('treats tentative and out-of-office as busy, free/workingElsewhere as free', () => {
    const tentative = daySlots('2026-11-24', [sched(MANUEL, [busy('2026-11-24', '09:00', '12:00', 'tentative')]), sched(NICO)]);
    expect(times(tentative).filter((t) => t < '12:00')).toEqual([]);
    const oof = daySlots('2026-11-24', [sched(MANUEL, [busy('2026-11-24', '00:00', '23:59', 'oof')]), sched(NICO)]);
    expect(oof).toEqual([]);
    const free = daySlots('2026-11-24', [sched(MANUEL, [busy('2026-11-24', '09:00', '17:00', 'free'), busy('2026-11-24', '09:00', '17:00', 'workingElsewhere')]), sched(NICO)]);
    expect(free).toHaveLength(11);
  });

  it('never books blindly: schedule error or missing mailbox → no slots', () => {
    expect(daySlots('2026-11-24', [sched(MANUEL, [], 'Postfach nicht erreichbar'), sched(NICO)])).toEqual([]);
    expect(daySlots('2026-11-24', [sched(NICO)])).toEqual([]);
  });

  it('matches mailboxes case-insensitively', () => {
    expect(daySlots('2026-11-24', [sched(MANUEL.toUpperCase()), sched(NICO)])).toHaveLength(11);
  });
});

describe('findSlots – Zusatzcall', () => {
  it('standard pair is Nico + Manuel, Zusatzcall is Nico + Lukas', () => {
    expect(participantsFor(RULES, false)).toMatchObject({ salesEmail: MANUEL, attendees: [NICO, MANUEL], onlyWhenUnavailable: null });
    expect(participantsFor(RULES, true)).toMatchObject({ salesEmail: LUKAS, attendees: [NICO, LUKAS], onlyWhenUnavailable: MANUEL });
  });

  it('offers Nico + Lukas only at times Manuel cannot', () => {
    const schedules = [sched(MANUEL, [busy('2026-11-24', '10:00', '10:30')]), sched(NICO), sched(LUKAS)];
    const standard = times(daySlots('2026-11-24', schedules));
    expect(standard).not.toContain('09:30');
    expect(standard).not.toContain('10:00');
    expect(standard).not.toContain('10:30');
    expect(standard).toContain('09:00');
    const extra = daySlots('2026-11-24', schedules, undefined, true);
    expect(times(extra)).toEqual(['09:30', '10:00', '10:30']);
    expect(extra[0].attendees.sort()).toEqual([LUKAS, NICO].sort());
  });

  it('Zusatzcall still needs Nico and Lukas free incl. buffers', () => {
    const schedules = [sched(MANUEL, [busy('2026-11-24', '09:00', '17:00')]), sched(NICO), sched(LUKAS, [busy('2026-11-24', '14:30', '15:00')])];
    const extra = times(daySlots('2026-11-24', schedules, undefined, true));
    expect(extra).not.toContain('14:00');
    expect(extra).not.toContain('14:30');
    expect(extra).not.toContain('15:00');
    expect(extra).toContain('15:30');
  });
});

describe('findSlots – DST weeks', () => {
  it('keeps local start times across the switch to summer time (28.03.2027)', () => {
    const schedules = allFree();
    const fri = daySlots('2027-03-26', schedules);
    const mon = daySlots('2027-03-29', schedules);
    expect(times(fri)[0]).toBe('09:00');
    expect(times(mon)[0]).toBe('09:00');
    expect(fri[0].start).toBe('2027-03-26T08:00:00.000Z'); // CET
    expect(mon[0].start).toBe('2027-03-29T07:00:00.000Z'); // CEST
    expect(times(mon)).not.toContain('12:30');
  });

  it('keeps local start times across the switch to winter time (25.10.2026)', () => {
    const slots = findSlotsFor({ from: z('2026-10-19', '00:00'), to: z('2026-10-31', '00:00'), schedules: allFree(), rules: RULES, now: z('2026-10-01', '08:00'), extraCall: false });
    const byDay = new Map<string, string[]>();
    for (const s of slots) byDay.set(localIsoDate(s.start), [...(byDay.get(localIsoDate(s.start)) ?? []), localHhmm(s.start)]);
    expect([...byDay.keys()]).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']);
    for (const list of byDay.values()) expect(list).toHaveLength(11);
    expect(slots.find((s) => localIsoDate(s.start) === '2026-10-26')!.start).toBe('2026-10-26T08:00:00.000Z');
  });

  it('applies buffers in local time during DST weeks', () => {
    const s = daySlots('2027-03-29', [sched(MANUEL, [busy('2027-03-29', '08:30', '09:00')]), sched(NICO)]);
    expect(times(s)).not.toContain('09:00');
    expect(times(s)).toContain('09:30');
  });
});

describe('double-booking guard', () => {
  const slot = { start: z('2026-11-24', '10:00').toISOString(), end: z('2026-11-24', '10:30').toISOString() };

  it('is free on an empty calendar', () => {
    expect(isSlotFree(slot, [sched(MANUEL), sched(NICO)], RULES)).toBe(true);
  });

  it('detects a meeting created in the meantime, also inside the buffers', () => {
    expect(isSlotFree(slot, [sched(MANUEL), sched(NICO, [busy('2026-11-24', '10:00', '10:30')])], RULES)).toBe(false);
    expect(isSlotFree(slot, [sched(MANUEL, [busy('2026-11-24', '09:15', '09:45')]), sched(NICO)], RULES)).toBe(false);
    expect(isSlotFree(slot, [sched(MANUEL, [busy('2026-11-24', '10:45', '11:15')]), sched(NICO)], RULES)).toBe(false);
    expect(isSlotFree(slot, [sched(MANUEL, [busy('2026-11-24', '11:00', '11:30')]), sched(NICO)], RULES)).toBe(true);
  });

  it('fails closed without schedules or with a schedule error', () => {
    expect(isSlotFree(slot, [], RULES)).toBe(false);
    expect(isSlotFree(slot, [sched(MANUEL, [], 'Fehler'), sched(NICO)], RULES)).toBe(false);
  });

  it('validates the start time itself', () => {
    expect(isAllowedStart(z('2026-11-24', '09:00'), RULES)).toBe(true);
    expect(isAllowedStart(z('2026-11-24', '11:30'), RULES)).toBe(true);
    expect(isAllowedStart(z('2026-11-24', '16:00'), RULES)).toBe(true);
    expect(isAllowedStart(z('2026-11-24', '12:00'), RULES)).toBe(false);
    expect(isAllowedStart(z('2026-11-24', '12:30'), RULES)).toBe(false);
    expect(isAllowedStart(z('2026-11-24', '13:30'), RULES)).toBe(false);
    expect(isAllowedStart(z('2026-11-24', '16:30'), RULES)).toBe(false);
    expect(isAllowedStart(z('2026-11-24', '09:15'), RULES)).toBe(false);
    expect(isAllowedStart(z('2026-11-21', '10:00'), RULES)).toBe(false);
    expect(isAllowedStart(z('2027-03-29', '09:00'), RULES)).toBe(true);
  });
});

describe('selectableMonths / monthThird / halfOfDay', () => {
  it('current month + 3, current month preselected before the 21st', () => {
    expect(selectableMonths(z('2026-11-20', '10:00'))).toEqual({
      months: ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01'],
      preselected: '2026-11-01',
    });
  });

  it('from the 21st the next month is preselected', () => {
    expect(selectableMonths(z('2026-11-21', '08:00')).preselected).toBe('2026-12-01');
    expect(selectableMonths(z('2026-12-28', '08:00'))).toEqual({
      months: ['2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01'],
      preselected: '2027-01-01',
    });
  });

  it('drops the current month on its last day («ab morgen»)', () => {
    expect(selectableMonths(z('2026-11-30', '15:00'))).toEqual({
      months: ['2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01'],
      preselected: '2026-12-01',
    });
  });

  it('uses Zurich time for the date', () => {
    // 23:30 UTC on 20.11. is already the 21st in Zurich
    expect(selectableMonths(new Date('2026-11-20T23:30:00Z')).preselected).toBe('2026-12-01');
  });

  it('splits the month into thirds 1–10, 11–20, 21–end', () => {
    expect(monthThird(z('2026-12-01', '10:00'))).toBe(1);
    expect(monthThird(z('2026-12-10', '16:00'))).toBe(1);
    expect(monthThird(z('2026-12-11', '09:00'))).toBe(2);
    expect(monthThird(z('2026-12-20', '09:00'))).toBe(2);
    expect(monthThird(z('2026-12-21', '09:00'))).toBe(3);
    expect(monthThird(z('2026-12-31', '09:00'))).toBe(3);
    expect(monthThird(new Date('2026-12-10T23:30:00Z'))).toBe(2);
  });

  it('knows the half-day', () => {
    expect(halfOfDay(z('2026-12-01', '11:30'))).toBe('morning');
    expect(halfOfDay(z('2026-12-01', '14:00'))).toBe('afternoon');
  });
});

/** Free month (only the standard rules) → slots via findSlots. */
function monthSlots(month: string, schedules: MailboxSchedule[] = allFree(), now = NOW): Slot[] {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return findSlotsFor({ from: z(month, '00:00'), to: z(next, '00:00'), schedules, rules: RULES, now, extraCall: false });
}

function expectValidProposals(ps: Proposal[], now = NOW) {
  const dates = ps.map((p) => localIsoDate(p.slot.start));
  const weeks = dates.map((d) => JSON.stringify(isoWeek(d)));
  expect(new Set(dates).size).toBe(ps.length);
  expect(new Set(weeks).size).toBe(ps.length); // never two in the same calendar week
  const tomorrow = localIsoDate(new Date(now.getTime() + 86_400_000));
  for (const d of dates) expect(d >= tomorrow).toBe(true);
  for (const p of ps) expect(isAllowedStart(p.slot.start, RULES)).toBe(true);
  const sorted = [...ps].sort((a, b) => a.slot.start.localeCompare(b.slot.start));
  expect(ps).toEqual(sorted);
}

describe('proposeThree', () => {
  const req = (month: string, preference: ProposalRequest['preference'] = 'any', excludeStarts: string[] = []): ProposalRequest => ({ month, preference, excludeStarts });

  it('one proposal per month third, alternating half-days, different days and times', () => {
    const ps = proposeThree(monthSlots('2026-12-01'), req('2026-12-01'), NOW, RULES);
    expect(ps).toHaveLength(3);
    expectValidProposals(ps);
    expect(ps.map((p) => p.monthThird)).toEqual([1, 2, 3]);
    expect(ps.map((p) => p.half)).toEqual(['morning', 'afternoon', 'morning']);
    expect(new Set(ps.map((p) => localHhmm(p.slot.start))).size).toBe(3);
    expect(new Set(ps.map((p) => weekdayOfIso(localIsoDate(p.slot.start)))).size).toBe(3);
  });

  it('time wish «Vormittag» / «Nachmittag»', () => {
    const morning = proposeThree(monthSlots('2026-12-01'), req('2026-12-01', 'morning'), NOW, RULES);
    expect(morning).toHaveLength(3);
    expect(morning.every((p) => p.half === 'morning' && localHhmm(p.slot.start) < '12:00')).toBe(true);
    expect(new Set(morning.map((p) => localHhmm(p.slot.start))).size).toBe(3);
    const afternoon = proposeThree(monthSlots('2026-12-01'), req('2026-12-01', 'afternoon'), NOW, RULES);
    expect(afternoon.every((p) => p.half === 'afternoon')).toBe(true);
    expectValidProposals(afternoon);
  });

  it('never two proposals in the same calendar week (10. and 11. of the month)', () => {
    // Only free: Thu 10.12. (third 1), Fri 11.12. + Mon 14.12. (third 2), Tue 22.12. (third 3).
    const only = new Set(['2026-12-10', '2026-12-11', '2026-12-14', '2026-12-22']);
    const slots = monthSlots('2026-12-01').filter((s) => only.has(localIsoDate(s.start)));
    const ps = proposeThree(slots, req('2026-12-01'), NOW, RULES);
    expect(ps.map((p) => localIsoDate(p.slot.start))).toEqual(['2026-12-10', '2026-12-14', '2026-12-22']);
    expectValidProposals(ps);
  });

  it('rather fewer proposals than two in one week', () => {
    const only = new Set(['2026-12-10', '2026-12-11', '2026-12-22']);
    const slots = monthSlots('2026-12-01').filter((s) => only.has(localIsoDate(s.start)));
    const ps = proposeThree(slots, req('2026-12-01'), NOW, RULES);
    expect(ps).toHaveLength(2);
    expectValidProposals(ps);
  });

  it('current month after the 10th: proposals from tomorrow, spread over the remaining thirds', () => {
    const now = z('2026-11-12', '15:00');
    const ps = proposeThree(monthSlots('2026-11-01', allFree(), now), req('2026-11-01'), now, RULES);
    expect(ps).toHaveLength(3);
    expectValidProposals(ps, now);
    expect(ps.every((p) => p.monthThird >= 2)).toBe(true);
  });

  it('never proposes today, even if the slot list contains it', () => {
    const now = z('2026-12-01', '07:00');
    const ps = proposeThree(monthSlots('2026-12-01', allFree(), z('2026-11-01', '07:00')), req('2026-12-01'), now, RULES);
    expect(ps.every((p) => localIsoDate(p.slot.start) > '2026-12-01')).toBe(true);
  });

  it('honours excluded starts', () => {
    const slots = monthSlots('2026-12-01');
    const first = proposeThree(slots, req('2026-12-01'), NOW, RULES);
    const again = proposeThree(slots, req('2026-12-01', 'any', first.map((p) => p.slot.start)), NOW, RULES);
    for (const p of again) expect(first.map((f) => f.slot.start)).not.toContain(p.slot.start);
    expectValidProposals(again);
  });

  it('busy calendars: only offers free slots and still keeps the week rule', () => {
    const allDay = (d: string) => busy(d, '00:00', '23:59');
    const blocked = ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-08', '2026-12-15', '2026-12-16', '2026-12-17'].map(allDay);
    const slots = monthSlots('2026-12-01', [sched(MANUEL, blocked), sched(NICO), sched(LUKAS)]);
    const ps = proposeThree(slots, req('2026-12-01'), NOW, RULES);
    expect(ps).toHaveLength(3);
    expectValidProposals(ps);
    for (const p of ps) expect(blocked.map((b) => localIsoDate(b.start))).not.toContain(localIsoDate(p.slot.start));
  });

  it('works in a DST month (March 2027)', () => {
    const now = z('2027-03-01', '08:00');
    const slots = monthSlots('2027-03-01', allFree(), now).filter((s) => localIsoDate(s.start) >= '2027-03-21');
    const ps = proposeThree(slots, req('2027-03-01', 'morning'), now, RULES);
    expect(ps.length).toBeGreaterThanOrEqual(2);
    expectValidProposals(ps, now);
    expect(ps.some((p) => localIsoDate(p.slot.start) >= '2027-03-29')).toBe(true);
  });

  it('returns nothing for an empty month', () => {
    expect(proposeThree([], req('2026-12-01'), NOW, RULES)).toEqual([]);
  });
});

describe('swapProposal («anderer»)', () => {
  const slots = monthSlots('2026-12-01');
  const request: ProposalRequest = { month: '2026-12-01', preference: 'any' };

  it('replaces exactly one proposal and keeps the other two', () => {
    const ps = proposeThree(slots, request, NOW, RULES);
    const swapped = swapProposal(ps, 1, slots, request, NOW, RULES)!;
    expect(swapped).toHaveLength(3);
    expect(swapped).toContainEqual(ps[0]);
    expect(swapped).toContainEqual(ps[2]);
    const fresh = swapped.find((p) => p.slot.start !== ps[0].slot.start && p.slot.start !== ps[2].slot.start)!;
    expect(fresh.slot.start).not.toBe(ps[1].slot.start);
    expect(fresh.monthThird).toBe(ps[1].monthThird);
    expect(fresh.half).toBe(ps[1].half);
    expectValidProposals(swapped);
  });

  it('keeps the week rule when swapping repeatedly and runs out gracefully', () => {
    const only = new Set(['2026-12-10', '2026-12-14', '2026-12-22', '2026-12-23']);
    const few = slots.filter((s) => only.has(localIsoDate(s.start)) && localHhmm(s.start) === '10:00');
    let ps = proposeThree(few, request, NOW, RULES);
    expect(ps).toHaveLength(3);
    const excluded: string[] = [];
    for (let i = 0; i < 5; i++) {
      excluded.push(ps[2].slot.start);
      const next = swapProposal(ps, 2, few, { ...request, excludeStarts: excluded }, NOW, RULES);
      if (!next) return; // nothing left – fine
      expectValidProposals(next);
      ps = next;
    }
  });
});

describe('texts', () => {
  it('formats the proposals chronologically in German', () => {
    const ps = proposeThree(monthSlots('2026-12-01'), { month: '2026-12-01', preference: 'any' }, NOW, RULES);
    const text = formatProposalsText([ps[2], ps[0], ps[1]]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`– ${formatSlot(ps[0].slot)}`);
    expect(formatSlot({ start: z('2026-12-01', '10:00').toISOString(), end: z('2026-12-01', '10:30').toISOString() })).toBe(
      'Dienstag, 1. Dezember 2026, 10:00–10:30 Uhr',
    );
    expect(text).not.toContain('ß');
  });

  it('fills templates and greets politely', () => {
    const tpl = 'Guten Tag {Anrede} {Nachname}\n{Firma} {Unbekannt}';
    const frau = personPlaceholders({ kls_salutation: 845140001, firstname: 'Anna', lastname: 'Muster', companyname: 'Muster AG' });
    expect(fillTemplate(tpl, frau)).toBe('Guten Tag Frau Muster\nMuster AG {Unbekannt}');
    const unknown = personPlaceholders({ kls_salutation: null, firstname: 'Anna', lastname: 'Muster', companyname: 'X' });
    expect(fillTemplate('Guten Tag {Anrede} {Nachname}', unknown)).toBe('Guten Tag Anna Muster');
    const none = personPlaceholders({ kls_salutation: null, firstname: null, lastname: null, companyname: 'X' });
    expect(fillTemplate('Guten Tag {Anrede} {Nachname}', none)).toBe('Guten Tag');
  });
});

describe('checkAttendeeEmail', () => {
  const opts = { leadDomain: 'muster-ag.example', internalDomains: ['kallysoft.example'] };

  it('accepts the company domain', () => {
    expect(checkAttendeeEmail(' Anna.Muster@Muster-AG.example ', opts)).toEqual({ ok: true, email: 'Anna.Muster@muster-ag.example', error: null, warning: null });
    expect(checkAttendeeEmail('it@mail.muster-ag.example', opts).warning).toBeNull();
  });

  it('rejects invalid formats', () => {
    for (const bad of ['', 'anna', 'anna@', '@muster.ch', 'anna@muster', 'anna@@muster.ch', 'anna muster@muster.ch', 'anna..m@muster.ch', 'anna@muster.c0m', 'anna@-muster.ch']) {
      expect(checkAttendeeEmail(bad, opts).ok, bad).toBe(false);
    }
  });

  it('catches typical typos', () => {
    expect(checkAttendeeEmail('anna@gmial.com', opts).error).toContain('gmail.com');
    expect(checkAttendeeEmail('anna@muster.con', opts).ok).toBe(false);
  });

  it('rejects internal addresses (they are invited automatically)', () => {
    expect(checkAttendeeEmail('nico@kallysoft.example', opts).ok).toBe(false);
  });

  it('warns about other domains and private addresses but allows them', () => {
    const other = checkAttendeeEmail('peter@partner-gmbh.ch', opts);
    expect(other.ok).toBe(true);
    expect(other.warning).toContain('muster-ag.example');
    const priv = checkAttendeeEmail('anna@gmail.com', opts);
    expect(priv.ok).toBe(true);
    expect(priv.warning).toContain('Private');
  });
});

describe('change sets for booking and proposals', () => {
  const actor: Actor = { kind: 'user', userId: 'u-markus', displayName: 'Markus', crmUserId: 'crm-markus', email: 'markus@kallysoft.example' };
  const lead = {
    leadid: 'lead-1',
    companyname: 'Muster AG',
    statecode: 0,
    statuscode: STATUS.NEW,
    ownerid: 'crm-other',
    kls_interests: [845140001],
    kls_callstatus: CALL_STATUS.NOT_REACHED,
    kls_rating_category: null,
    numberofemployees: 40,
    kls_lead_support: null,
    subject: null,
    decisionmaker: null,
  };
  const rule = (key: 'meeting_booked' | 'proposals_sent') => DEFAULT_RESULT_GROUP_RULES.find((r) => r.key === key)!;

  it('«Termin gebucht»: call status, lead support, subject, interests (added), owner, contacted, appointment', () => {
    const cs = buildSchedulingChangeSet({
      rule: rule('meeting_booked'),
      lead,
      actor,
      input: { decisionMakerInMeeting: false },
      appointment: { subject: 'Vorstellung – Muster AG', text: 'Hallo', start: '2026-12-01T09:00:00.000Z', end: '2026-12-01T09:30:00.000Z', to: ['anna@muster.example'] },
    });
    const byField = Object.fromEntries(cs.operations.map((o) => [o.field, o]));
    expect(byField.kls_callstatus.newValue).toBe(CALL_STATUS.MEETING_BOOKED);
    expect(byField.kls_callstatus.oldValue).toBe(CALL_STATUS.NOT_REACHED);
    expect(byField.kls_callstatus.newDisplay).toBeTruthy();
    expect(byField.kls_lead_support.newValue).toBe(LEAD_SUPPORT.SALES);
    expect(byField.subject.newValue).toBe('KI Termin');
    expect(byField.kls_interests.newValue).toEqual([845140001, INTEREST_KI_SERVICES]);
    expect(byField.kls_interests.mode).toBe('add_to_multiselect');
    expect(byField.ownerid.newValue).toBe('crm-markus');
    expect(byField.decisionmaker).toBeUndefined();
    expect(cs.stateChanges).toEqual([expect.objectContaining({ statecode: 0, statuscode: STATUS.CONTACTED })]);
    expect(cs.activities).toEqual([expect.objectContaining({ type: 'appointment', action: 'create', leadId: 'lead-1' })]);
    expect(cs.kind).toBe('booking');
    expect(cs.ruleKey).toBe('meeting_booked');
    expect(cs.baseSnapshot['lead:lead-1:kls_callstatus']).toBe(CALL_STATUS.NOT_REACHED);
    expect(new Set(cs.operations.map((o) => o.id)).size).toBe(cs.operations.length);
  });

  it('sets «Entscheider» only when he attends', () => {
    const cs = buildSchedulingChangeSet({ rule: rule('meeting_booked'), lead, actor, input: { decisionMakerInMeeting: true } });
    expect(cs.operations.find((o) => o.field === 'decisionmaker')?.newValue).toBe(true);
  });

  it('leaves out unchanged values (no «alt = neu» rows)', () => {
    const done = { ...lead, kls_callstatus: CALL_STATUS.MEETING_BOOKED, kls_lead_support: LEAD_SUPPORT.SALES, subject: 'KI Termin', kls_interests: [INTEREST_KI_SERVICES], ownerid: 'crm-markus', statuscode: STATUS.CONTACTED };
    const cs = buildSchedulingChangeSet({ rule: rule('meeting_booked'), lead: done, actor, input: {} });
    expect(cs.operations).toEqual([]);
    expect(cs.stateChanges).toEqual([]);
  });

  it('keeps «Austausch» / «Zweitkontakt»', () => {
    const cs = buildSchedulingChangeSet({ rule: rule('meeting_booked'), lead: { ...lead, statuscode: STATUS.EXCHANGE }, actor, input: {} });
    expect(cs.stateChanges).toEqual([]);
  });

  it('«3 Vorschläge gesendet»: status 845140009, interests, e-mail activity and follow-up task', () => {
    const task = { id: 't1', action: 'create' as const, leadId: 'lead-1', subject: 'Nachfassen Terminvorschläge Muster AG', taskType: 'follow_up' as const, dueAt: '2026-11-25T09:15:00.000Z' };
    const cs = buildSchedulingChangeSet({
      rule: rule('proposals_sent'),
      lead,
      actor,
      input: {},
      email: { subject: 'Terminvorschläge', text: 'Text', to: ['anna@muster.example'], sentAt: '2026-11-20T09:15:00.000Z' },
      task,
    });
    expect(cs.operations.find((o) => o.field === 'kls_callstatus')?.newValue).toBe(845140009);
    expect(cs.operations.find((o) => o.field === 'kls_interests')?.newValue).toEqual([845140001, INTEREST_KI_SERVICES]);
    expect(cs.activities).toEqual([expect.objectContaining({ type: 'email', to: ['anna@muster.example'] })]);
    expect(cs.tasks).toEqual([task]);
    expect(cs.kind).toBe('mail');
    expect(cs.ruleKey).toBe('proposals_sent');
  });

  it('call status after a cancellation only on Markus\' choice', () => {
    const cs = buildCallStatusChangeSet({ leadid: 'lead-1', kls_callstatus: CALL_STATUS.MEETING_BOOKED }, CALL_STATUS.CALLBACK_7_DAYS);
    expect(cs.operations).toEqual([expect.objectContaining({ field: 'kls_callstatus', oldValue: CALL_STATUS.MEETING_BOOKED, newValue: CALL_STATUS.CALLBACK_7_DAYS })]);
  });
});
