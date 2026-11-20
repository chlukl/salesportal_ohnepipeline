/**
 * Slot search, «3 Vorschläge», attendee checks and the CRM change sets of a booking (INTENT 6.6, 6.8, 6.5).
 *
 * Rules (INTENT 6.6, decided 17.11.2026):
 * - 30 min Teams meeting, start 09:00–11:30 and 14:00–16:00 (Europe/Zurich), no meetings 12:30–14:00, Mon–Fri.
 * - 30 min free before AND after for ALL internal attendees at EVERY start time – also at 09:00 and 14:00
 *   (the old Terminplaner skipped the buffer before 09:00/14:00; the portal does not).
 * - Participants Nico + Manuel; switch «Zusatzcall» → Nico + Lukas, only at times Manuel cannot.
 * - Double-booking guard: availability is checked again right before the event is created (`isSlotFree`).
 * - 3 Vorschläge: logic of Terminplaner 1.0.0.14 (month selection, time wish, one proposal per month third, alternating
 *   half-days, different days and times, «anderer» swaps one) plus: never two proposals in the same calendar week.
 *
 * Pure functions only (used by server and web). All wall-clock logic runs in `rules.timezone` (default Europe/Zurich).
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { CALL_STATUS, multiOptionLabels, optionLabel, STATE, STATUS, type OptionSetName } from './i18n';
import type { ChangeSetDraft } from './resultGroups';
import type {
  ActivityOp,
  Actor,
  BookingRules,
  BusyInterval,
  DayHalf,
  FieldOp,
  IsoDate,
  IsoDateTime,
  Lead,
  MailboxSchedule,
  Proposal,
  ProposalRequest,
  ResultGroupRule,
  ResultInput,
  RuleCondition,
  Slot,
  StateOp,
  TaskOp,
} from './types';

const DEFAULT_TZ = 'Europe/Zurich';
const MINUTE = 60_000;

// =====================================================================================================================
// Small date helpers (wall clock in a time zone, calendar arithmetic on `YYYY-MM-DD` strings → DST-safe)
// =====================================================================================================================

function tzOf(rules?: Pick<BookingRules, 'timezone'> | null, timeZone?: string): string {
  return timeZone || rules?.timezone || DEFAULT_TZ;
}

/** `YYYY-MM-DD` of an instant in `tz`. */
export function localIsoDate(date: Date | string, timeZone = DEFAULT_TZ): IsoDate {
  return formatInTimeZone(typeof date === 'string' ? new Date(date) : date, timeZone, 'yyyy-MM-dd');
}

/** `HH:mm` of an instant in `tz`. */
export function localHhmm(date: Date | string, timeZone = DEFAULT_TZ): string {
  return formatInTimeZone(typeof date === 'string' ? new Date(date) : date, timeZone, 'HH:mm');
}

/** UTC instant of a wall-clock time in `tz` (DST handled by date-fns-tz). */
export function atLocalTime(isoDate: IsoDate, hhmm: string, timeZone = DEFAULT_TZ): Date {
  return fromZonedTime(`${isoDate}T${hhmm}:00`, timeZone);
}

/** Calendar arithmetic on `YYYY-MM-DD` (no time zone involved). */
export function addDaysIso(isoDate: IsoDate, days: number): IsoDate {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOfIso(isoDate: IsoDate): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday of the ISO week of `isoDate`. */
export function mondayOfIso(isoDate: IsoDate): IsoDate {
  const wd = weekdayOfIso(isoDate);
  return addDaysIso(isoDate, wd === 0 ? -6 : 1 - wd);
}

/** ISO-8601 calendar week, e.g. `{ year: 2026, week: 48 }` («KW 48»). */
export function isoWeek(isoDate: IsoDate): { year: number; week: number } {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day); // Thursday of this week decides the year
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

function weekKey(isoDate: IsoDate): string {
  const w = isoWeek(isoDate);
  return `${w.year}-${w.week}`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE);
}

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// =====================================================================================================================
// Participants (Standard Nico + Manuel, «Zusatzcall» Nico + Lukas)
// =====================================================================================================================

export interface Participants {
  extraCall: boolean;
  /** Organizer of the Teams meeting (the booked sales). */
  salesEmail: string;
  specialistEmail: string;
  /** Internal attendees that must all be free (incl. buffers). */
  attendees: string[];
  /** Zusatzcall: slot only allowed when this mailbox (Manuel) cannot at that time. */
  onlyWhenUnavailable: string | null;
}

export function participantsFor(rules: BookingRules, extraCall: boolean): Participants {
  const salesEmail = extraCall ? rules.extraCallSalesEmail : rules.defaultSalesEmail;
  return {
    extraCall,
    salesEmail,
    specialistEmail: rules.specialistEmail,
    attendees: [rules.specialistEmail, salesEmail],
    onlyWhenUnavailable: extraCall ? rules.defaultSalesEmail : null,
  };
}

// =====================================================================================================================
// Free/busy
// =====================================================================================================================

/** Statuses that do not block a slot (Graph: free, workingElsewhere). Tentative counts as busy (conservative). */
const NON_BLOCKING: BusyInterval['status'][] = ['free', 'workingElsewhere'];

/** Buffered interval of a meeting: [start − before, end + after). */
export function bufferedInterval(slot: Pick<Slot, 'start' | 'end'>, rules: Pick<BookingRules, 'bufferBeforeMinutes' | 'bufferAfterMinutes'>): { start: Date; end: Date } {
  return {
    start: addMinutes(new Date(slot.start), -rules.bufferBeforeMinutes),
    end: addMinutes(new Date(slot.end), rules.bufferAfterMinutes),
  };
}

/** Is the mailbox free in [from, to)? Unknown mailbox or schedule error → not free (never book blindly). */
export function isMailboxFree(schedules: MailboxSchedule[], email: string, from: Date, to: Date): boolean {
  const schedule = schedules.find((s) => sameEmail(s.email, email));
  if (!schedule || schedule.error) return false;
  const a = from.getTime();
  const b = to.getTime();
  return !schedule.busy.some((i) => {
    if (NON_BLOCKING.includes(i.status)) return false;
    return new Date(i.start).getTime() < b && new Date(i.end).getTime() > a;
  });
}

/**
 * Double-booking guard: every given schedule must be free for start − buffer … end + buffer.
 * Pass the schedules of the internal attendees of the slot (fresh from `getSchedule`).
 */
export function isSlotFree(slot: Pick<Slot, 'start' | 'end'>, schedules: MailboxSchedule[], rules: BookingRules): boolean {
  if (schedules.length === 0) return false;
  const { start, end } = bufferedInterval(slot, rules);
  return schedules.every((s) => isMailboxFree([s], s.email, start, end));
}

/** Is `start` an allowed start time (weekday, start window, step, not in a blocked window)? */
export function isAllowedStart(start: Date | string, rules: BookingRules): boolean {
  const tz = tzOf(rules);
  const s = typeof start === 'string' ? new Date(start) : start;
  const day = localIsoDate(s, tz);
  const wd = weekdayOfIso(day);
  if (wd === 0 || wd === 6) return false;
  const hhmm = localHhmm(s, tz);
  if (s.getUTCSeconds() !== 0 || s.getUTCMilliseconds() !== 0) return false;
  const min = toMinutes(hhmm);
  const inWindow = rules.startWindows.some((w) => {
    const from = toMinutes(w.from);
    return min >= from && min <= toMinutes(w.to) && (min - from) % rules.slotStepMinutes === 0;
  });
  if (!inWindow) return false;
  return !overlapsBlocked(day, s, addMinutes(s, rules.durationMinutes), rules, tz);
}

function overlapsBlocked(day: IsoDate, start: Date, end: Date, rules: BookingRules, tz: string): boolean {
  return rules.blockedWindows.some((w) => {
    const bs = atLocalTime(day, w.from, tz).getTime();
    const be = atLocalTime(day, w.to, tz).getTime();
    return start.getTime() < be && end.getTime() > bs;
  });
}

export interface FindSlotsInput {
  from: Date;
  to: Date;
  schedules: MailboxSchedule[];
  /** Mailboxes that must all be free (e.g. Manuel + Nico). */
  requiredAttendees: string[];
  rules: BookingRules;
  now: Date;
  /** «Zusatzcall»: only offer starts at which this mailbox (Manuel) is NOT free (incl. buffers). */
  onlyWhenUnavailable?: string | null;
  /** Earliest start relative to now (default: the buffer before, so preparation time is still ahead). */
  minLeadMinutes?: number;
}

/** All bookable starts in [from, to), sorted. Every start is checked with buffers for every required attendee. */
export function findSlots(input: FindSlotsInput): Slot[] {
  const { from, to, schedules, requiredAttendees, rules, now } = input;
  const tz = tzOf(rules);
  const minStart = now.getTime() + (input.minLeadMinutes ?? rules.bufferBeforeMinutes) * MINUTE;
  const out: Slot[] = [];
  const seen = new Set<number>();
  if (requiredAttendees.length === 0 || to.getTime() <= from.getTime()) return out;
  let day = localIsoDate(from, tz);
  const lastDay = localIsoDate(to, tz);
  for (let guard = 0; day <= lastDay && guard < 400; guard++, day = addDaysIso(day, 1)) {
    const wd = weekdayOfIso(day);
    if (wd === 0 || wd === 6) continue;
    for (const w of rules.startWindows) {
      for (let m = toMinutes(w.from); m <= toMinutes(w.to); m += Math.max(5, rules.slotStepMinutes)) {
        const start = atLocalTime(day, fromMinutes(m), tz);
        const t = start.getTime();
        if (seen.has(t) || t < from.getTime() || t >= to.getTime() || t < minStart) continue;
        const end = addMinutes(start, rules.durationMinutes);
        if (overlapsBlocked(day, start, end, rules, tz)) continue;
        const buf = bufferedInterval({ start: start.toISOString(), end: end.toISOString() }, rules);
        if (!requiredAttendees.every((email) => isMailboxFree(schedules, email, buf.start, buf.end))) continue;
        if (input.onlyWhenUnavailable && isMailboxFree(schedules, input.onlyWhenUnavailable, buf.start, buf.end)) continue;
        seen.add(t);
        out.push({ start: start.toISOString(), end: end.toISOString(), attendees: [...requiredAttendees] });
      }
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Slots for the standard pair or the «Zusatzcall» (Nico + Lukas only where Manuel cannot). */
export function findSlotsFor(input: Omit<FindSlotsInput, 'requiredAttendees' | 'onlyWhenUnavailable'> & { extraCall: boolean }): Slot[] {
  const p = participantsFor(input.rules, input.extraCall);
  return findSlots({ ...input, requiredAttendees: p.attendees, onlyWhenUnavailable: p.onlyWhenUnavailable });
}

// =====================================================================================================================
// 3 Vorschläge (Terminplaner 1.0.0.14 + week rule)
// =====================================================================================================================

/** 1 = days 1–10, 2 = 11–20, 3 = 21–end. */
export function monthThird(date: Date | string, timeZone = DEFAULT_TZ): 1 | 2 | 3 {
  const day = Number(localIsoDate(date, timeZone).slice(8, 10));
  return day <= 10 ? 1 : day <= 20 ? 2 : 3;
}

export function halfOfDay(date: Date | string, timeZone = DEFAULT_TZ): Exclude<DayHalf, 'any'> {
  return toMinutes(localHhmm(date, timeZone)) < 12 * 60 ? 'morning' : 'afternoon';
}

/** Selectable months: current month (from tomorrow) + 3 following; from the 21st the next month is preselected. */
export function selectableMonths(now: Date, timeZone = DEFAULT_TZ): { months: IsoDate[]; preselected: IsoDate } {
  const today = localIsoDate(now, timeZone);
  const tomorrow = addDaysIso(today, 1);
  const first = `${today.slice(0, 7)}-01`;
  const nextMonth = (iso: IsoDate) => {
    const [y, m] = iso.split('-').map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  };
  const months: IsoDate[] = [];
  // The current month only counts if «ab morgen» still has days in it.
  if (tomorrow.slice(0, 7) === today.slice(0, 7)) months.push(first);
  // Always four choices (on the last day of a month: the next four months).
  for (let m = nextMonth(first); months.length < 4; m = nextMonth(m)) months.push(m);
  const day = Number(today.slice(8, 10));
  const preselected = day >= 21 || months[0] !== first ? nextMonth(first) : first;
  return { months, preselected };
}

interface Candidate {
  slot: Slot;
  t: number;
  date: IsoDate;
  third: 1 | 2 | 3;
  half: Exclude<DayHalf, 'any'>;
  week: string;
  time: string;
  weekday: number;
}

/** Best weekdays first (Tuesday is the strongest day, Mon/Fri last), then best times (10:00, 14–15 Uhr). */
const WEEKDAY_RANK: Record<number, number> = { 2: 0, 3: 0, 4: 0, 1: 1, 5: 1 };
const TIME_RANK = ['10:00', '14:00', '14:30', '09:30', '10:30', '15:00', '11:00', '09:00', '15:30', '11:30', '16:00'];
const timeRank = (hhmm: string) => {
  const i = TIME_RANK.indexOf(hhmm);
  return i < 0 ? TIME_RANK.length : i;
};

function toCandidates(slots: Slot[], request: ProposalRequest, now: Date, tz: string, extraExcluded: string[] = []): Candidate[] {
  const month = request.month.slice(0, 7);
  const tomorrow = addDaysIso(localIsoDate(now, tz), 1);
  const excluded = new Set([...(request.excludeStarts ?? []), ...extraExcluded].map((s) => new Date(s).getTime()));
  const out: Candidate[] = [];
  for (const slot of slots) {
    const t = new Date(slot.start).getTime();
    const date = localIsoDate(slot.start, tz);
    if (date.slice(0, 7) !== month || date < tomorrow || excluded.has(t)) continue;
    const half = halfOfDay(slot.start, tz);
    if (request.preference !== 'any' && half !== request.preference) continue;
    out.push({
      slot,
      t,
      date,
      third: monthThird(slot.start, tz),
      half,
      week: weekKey(date),
      time: localHhmm(slot.start, tz),
      weekday: weekdayOfIso(date),
    });
  }
  // Preference order: good weekday, then earliest date, then the best time of that day.
  return out.sort(
    (a, b) => (WEEKDAY_RANK[a.weekday] ?? 2) - (WEEKDAY_RANK[b.weekday] ?? 2) || a.date.localeCompare(b.date) || timeRank(a.time) - timeRank(b.time),
  );
}

interface Constraints {
  distinctWeekday: boolean;
  distinctTime: boolean;
}

/** Hard rules: never the same calendar week, never the same day. Soft: different weekdays and different times. */
function compatible(c: Candidate, chosen: Candidate[], k: Constraints): boolean {
  for (const x of chosen) {
    if (x.week === c.week || x.date === c.date) return false;
    if (k.distinctTime && x.time === c.time) return false;
    if (k.distinctWeekday && x.weekday === c.weekday) return false;
  }
  return true;
}

const MAX_PER_GROUP = 80;

/** Backtracking: one candidate per group, groups in chronological order. */
function solve(groups: Candidate[][], k: Constraints, chronological: boolean): Candidate[] | null {
  const chosen: Candidate[] = [];
  const rec = (i: number): boolean => {
    if (i === groups.length) return true;
    for (const c of groups[i].slice(0, MAX_PER_GROUP)) {
      if (chronological && chosen.length && c.t <= chosen[chosen.length - 1].t) continue;
      if (!compatible(c, chosen, k)) continue;
      chosen.push(c);
      if (rec(i + 1)) return true;
      chosen.pop();
    }
    return false;
  };
  return rec(0) ? [...chosen] : null;
}

const RELAX_LEVELS: Constraints[] = [
  { distinctWeekday: true, distinctTime: true },
  { distinctWeekday: false, distinctTime: true },
  { distinctWeekday: false, distinctTime: false },
];

function halfPatterns(preference: DayHalf, n: number): Exclude<DayHalf, 'any'>[][] {
  if (preference !== 'any') return [Array.from({ length: n }, () => preference)];
  const alt = (first: Exclude<DayHalf, 'any'>) =>
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? first : first === 'morning' ? 'afternoon' : 'morning')) as Exclude<DayHalf, 'any'>[];
  return [alt('morning'), alt('afternoon')];
}

function toProposal(c: Candidate): Proposal {
  return { slot: c.slot, monthThird: c.third, half: c.half };
}

/**
 * Three proposals for the selected month: one per month third (1–10, 11–20, 21–end), half-days alternating (for «egal»),
 * different days and times, never two in the same calendar week, only from tomorrow on. If a third has no possible
 * slot (e.g. current month after the 10th), the remaining proposals come from the other thirds – the week rule still
 * holds. Returns fewer than 3 only when the month does not allow more.
 */
export function proposeThree(slots: Slot[], request: ProposalRequest, now: Date, rules: BookingRules): Proposal[] {
  const tz = tzOf(rules);
  const cands = toCandidates(slots, request, now, tz);
  if (cands.length === 0) return [];
  const byThird = ([1, 2, 3] as const).map((third) => cands.filter((c) => c.third === third));

  // 1) Classic: one per third, alternating halves.
  if (byThird.every((g) => g.length > 0)) {
    for (const k of RELAX_LEVELS) {
      for (const pattern of halfPatterns(request.preference, 3)) {
        const res = solve(byThird.map((g, i) => g.filter((c) => c.half === pattern[i])), k, true);
        if (res) return res.map(toProposal);
      }
    }
  }
  // 2) Fallback: spread over the thirds that have slots (fewer thirds or no solution per third).
  for (const n of [3, 2, 1]) {
    for (const k of RELAX_LEVELS) {
      for (const pattern of [...halfPatterns(request.preference, n), Array.from({ length: n }, () => null)]) {
        const groups = pattern.map((half) => (half ? cands.filter((c) => c.half === half) : cands));
        const res = solve(groups, k, true);
        if (res) return res.map(toProposal);
      }
    }
  }
  return [];
}

/**
 * «anderer»: replaces proposal `index`, keeps the other two. The replacement stays in the same month third and half-day
 * if possible and respects the week rule against the kept proposals. Returns null if no other slot fits.
 */
export function swapProposal(current: Proposal[], index: number, slots: Slot[], request: ProposalRequest, now: Date, rules: BookingRules): Proposal[] | null {
  const tz = tzOf(rules);
  const replaced = current[index];
  if (!replaced) return null;
  const kept = current.filter((_, i) => i !== index);
  const keptCands = toCandidates(
    kept.map((p) => p.slot),
    { ...request, preference: 'any', excludeStarts: [] },
    new Date(0),
    tz,
  );
  const cands = toCandidates(slots, request, now, tz, current.map((p) => p.slot.start));
  const tiers: ((c: Candidate) => boolean)[] = [
    (c) => c.third === replaced.monthThird && c.half === replaced.half,
    (c) => c.third === replaced.monthThird,
    (c) => c.half === replaced.half,
    () => true,
  ];
  for (const tier of tiers) {
    for (const k of RELAX_LEVELS) {
      const found = cands.find((c) => tier(c) && compatible(c, keptCands, k));
      if (found) return [...kept, toProposal(found)].sort((a, b) => a.slot.start.localeCompare(b.slot.start));
    }
  }
  return null;
}

// =====================================================================================================================
// Texts
// =====================================================================================================================

const WEEKDAYS_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const WEEKDAYS_SHORT_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** «Dienstag, 24. November 2026». */
export function formatLongDate(date: Date | string, timeZone = DEFAULT_TZ): string {
  const iso = localIsoDate(date, timeZone);
  const [y, m, d] = iso.split('-').map(Number);
  return `${WEEKDAYS_DE[weekdayOfIso(iso)]}, ${d}. ${MONTHS_DE[m - 1]} ${y}`;
}

/** «Di, 24.11.». */
export function formatShortDate(date: Date | string, timeZone = DEFAULT_TZ): string {
  const iso = localIsoDate(date, timeZone);
  return `${WEEKDAYS_SHORT_DE[weekdayOfIso(iso)]}, ${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
}

/** «November 2026» for `2026-11-01`. */
export function formatMonth(isoMonth: IsoDate): string {
  const [y, m] = isoMonth.split('-').map(Number);
  return `${MONTHS_DE[m - 1]} ${y}`;
}

/** «Dienstag, 24. November 2026, 10:00–10:30 Uhr». */
export function formatSlot(slot: Pick<Slot, 'start' | 'end'>, timeZone = DEFAULT_TZ): string {
  return `${formatLongDate(slot.start, timeZone)}, ${localHhmm(slot.start, timeZone)}–${localHhmm(slot.end, timeZone)} Uhr`;
}

/** Mail text with the three proposals (German, Europe/Zurich), chronological. */
export function formatProposalsText(proposals: Proposal[], timeZone = DEFAULT_TZ): string {
  return [...proposals]
    .sort((a, b) => a.slot.start.localeCompare(b.slot.start))
    .map((p) => `– ${formatSlot(p.slot, timeZone)}`)
    .join('\n');
}

/** Replace `{Key}` placeholders; unknown placeholders stay visible so nothing is silently lost. */
export function fillTemplate(template: string, values: Record<string, string | null | undefined>): string {
  const filled = template.replace(/\{([A-Za-zÄÖÜäöü_]+)\}/g, (match, key: string) => {
    const v = values[key];
    return v == null ? match : v;
  });
  return filled
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, ''))
    .join('\n');
}

const SALUTATIONS: Record<number, string> = { 845140000: 'Herr', 845140001: 'Frau' };

/** Placeholders {Anrede} {Nachname} {Vorname} {Firma}: «Guten Tag Frau Muster» or «Guten Tag Anna Muster». */
export function personPlaceholders(lead: Pick<Lead, 'kls_salutation' | 'firstname' | 'lastname' | 'companyname'>): Record<string, string> {
  const salutation = lead.kls_salutation != null ? SALUTATIONS[lead.kls_salutation] : undefined;
  return {
    Anrede: salutation ?? (lead.firstname ?? ''),
    Nachname: lead.lastname ?? '',
    Vorname: lead.firstname ?? '',
    Firma: lead.companyname,
  };
}

/** Meeting subject from the template «Vorstellung der Kallysoft Informatik AG als KI-Spezialist – {Firma}». */
export function bookingSubject(template: string, companyName: string): string {
  return fillTemplate(template, { Firma: companyName }).trim();
}

// =====================================================================================================================
// External attendees (format + domain plausibility, INTENT 6.6 / 6.8)
// =====================================================================================================================

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/;
const FREE_MAIL = ['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.ch', 'outlook.com', 'live.com', 'yahoo.com', 'gmx.ch', 'gmx.net', 'gmx.de', 'bluewin.ch', 'icloud.com', 'protonmail.com', 'proton.me', 'web.de', 'sunrise.ch'];
const TYPO_DOMAINS: Record<string, string> = {
  'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.ch': 'gmail.com',
  'gamil.com': 'gmail.com',
  'hotmial.com': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'bluewin.com': 'bluewin.ch',
  'bluwin.ch': 'bluewin.ch',
};
const TYPO_TLDS = ['con', 'cmo', 'chh', 'cj', 'vh', 'comm', 'om'];

export interface AttendeeCheck {
  ok: boolean;
  /** Normalized (trimmed, lower-case domain). */
  email: string;
  /** Blocking problem. */
  error: string | null;
  /** Plausibility hint – booking still possible. */
  warning: string | null;
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at < 0 ? null : email.slice(at + 1).toLowerCase();
}

function baseDomain(domain: string): string {
  const parts = domain.toLowerCase().replace(/^www\./, '').split('.');
  return parts.slice(-2).join('.');
}

/** Format + domain plausibility of an external attendee. `leadDomain` = company domain, `internalDomains` = Kallysoft. */
export function checkAttendeeEmail(raw: string, options: { leadDomain?: string | null; internalDomains?: string[] } = {}): AttendeeCheck {
  const trimmed = raw.trim();
  const at = trimmed.lastIndexOf('@');
  const email = at > 0 ? `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}` : trimmed;
  const fail = (error: string): AttendeeCheck => ({ ok: false, email, error, warning: null });
  if (!email) return fail('Bitte eine E-Mail-Adresse eingeben');
  if (email.length > 254 || !EMAIL_RE.test(email) || email.includes('..')) return fail('Das ist keine gültige E-Mail-Adresse');
  const domain = emailDomain(email)!;
  const tld = domain.split('.').pop()!;
  if (!/^[a-z]{2,24}$/.test(tld)) return fail('Die Endung der Domain ist ungültig');
  if (TYPO_TLDS.includes(tld)) return fail(`Tippfehler? Endung «.${tld}» gibt es so nicht`);
  if (TYPO_DOMAINS[domain]) return fail(`Tippfehler? Meinten Sie «${TYPO_DOMAINS[domain]}»?`);
  const internal = (options.internalDomains ?? []).map((d) => d.toLowerCase());
  if (internal.includes(domain)) return fail('Interne Adresse – Nico und der Sales sind automatisch eingeladen');
  let warning: string | null = null;
  if (FREE_MAIL.includes(domain)) warning = `Private Adresse (${domain}) – bitte prüfen`;
  else if (options.leadDomain && baseDomain(options.leadDomain) !== baseDomain(domain)) {
    warning = `Andere Domain als die Firma (${baseDomain(options.leadDomain)}) – bitte prüfen`;
  }
  return { ok: true, email, error: null, warning };
}

// =====================================================================================================================
// CRM change sets of a booking / of sent proposals (INTENT 6.5 «Termin gebucht», «3 Vorschläge gesendet»)
// =====================================================================================================================

export interface SchedulingChangeSetInput {
  /** Active rule of `meeting_booked` or `proposals_sent` (admin-editable, versioned). */
  rule: ResultGroupRule;
  lead: Pick<
    Lead,
    'leadid' | 'companyname' | 'statecode' | 'statuscode' | 'ownerid' | 'kls_interests' | 'kls_callstatus' | 'kls_rating_category' | 'numberofemployees'
  > &
    Partial<Lead>;
  actor: Actor;
  input: ResultInput;
  callSessionId?: string | null;
  /** Booked meeting → appointment activity. */
  appointment?: { subject: string; text: string | null; start: IsoDateTime; end: IsoDateTime; to: string[] } | null;
  /** Sent proposals mail → e-mail activity. */
  email?: { subject: string; text: string; to: string[]; sentAt: IsoDateTime } | null;
  /** Follow-up task (already decided by the task rules). */
  task?: TaskOp | null;
  /** Prefix for the operation ids (unique within the change set). */
  idPrefix?: string;
}

const LEAD_FIELD_SET: Partial<Record<string, OptionSetName>> = {
  kls_callstatus: 'kls_callstatus',
  kls_rating_category: 'kls_rating_category',
  kls_lead_support: 'kls_lead_support',
  statuscode: 'statuscode',
};

function displayOf(field: string, value: unknown): string | null {
  if (value == null) return null;
  if (field === 'kls_interests') return multiOptionLabels('kls_interests', value as number[]).join(', ') || '–';
  const set = LEAD_FIELD_SET[field];
  if (set && typeof value === 'number') return optionLabel(set, value);
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  return String(value);
}

/** Minimal condition evaluation for the scheduling groups (same semantics as the result-group engine). */
export function conditionHolds(condition: RuleCondition | undefined, lead: Pick<Lead, 'numberofemployees'>, input: ResultInput): boolean {
  if (!condition) return true;
  switch (condition.kind) {
    case 'always':
      return true;
    case 'interest_gte':
      return (input.interest ?? -1) >= condition.value;
    case 'employees_lt': {
      const n = input.employees ?? lead.numberofemployees;
      return n != null && n < condition.value;
    }
    case 'employees_gte': {
      const n = input.employees ?? lead.numberofemployees;
      return n != null && n >= condition.value;
    }
    case 'input_true':
      return input[condition.input] === true;
    case 'input_present':
      return input[condition.input] != null && input[condition.input] !== '';
    case 'input_absent':
      return input[condition.input] == null || input[condition.input] === '';
    default:
      return false;
  }
}

const snapKey = (entity: string, id: string, field: string) => `${entity}:${id}:${field}`;

/**
 * Change set for «Termin gebucht» / «3 Vorschläge gesendet»: lead fields of the rule (alt → neu, unchanged values
 * are left out), owner → caller, Neu → Kontaktiert, plus the appointment / e-mail activity and the follow-up task.
 * Goes through the normal approval preview (nothing is pushed here).
 */
export function buildSchedulingChangeSet(args: SchedulingChangeSetInput): ChangeSetDraft {
  const { rule, lead, actor, input } = args;
  const prefix = args.idPrefix ?? rule.key;
  let n = 0;
  const nextId = (kind: string) => `${prefix}-${kind}-${++n}`;
  const operations: FieldOp[] = [];
  const baseSnapshot: Record<string, unknown> = {};
  const current = lead as unknown as Record<string, unknown>;

  const addOp = (field: string, label: string, newValue: unknown, mode: FieldOp['mode'] = 'set') => {
    const oldValue = current[field] ?? null;
    let value = newValue;
    if (mode === 'add_to_multiselect') {
      const list = Array.isArray(oldValue) ? (oldValue as number[]) : [];
      const add = Array.isArray(newValue) ? (newValue as number[]) : [newValue as number];
      const missing = add.filter((v) => !list.includes(v));
      if (missing.length === 0) return;
      value = [...list, ...missing];
    } else if (mode === 'set_if_empty') {
      if (oldValue != null && oldValue !== '') return;
    } else if (JSON.stringify(oldValue) === JSON.stringify(newValue)) {
      return;
    }
    if (operations.some((o) => o.field === field)) return;
    baseSnapshot[snapKey('lead', lead.leadid, field)] = oldValue;
    operations.push({
      id: nextId('field'),
      entity: 'lead',
      entityId: lead.leadid,
      field,
      label,
      oldValue,
      newValue: value,
      mode,
      oldDisplay: displayOf(field, oldValue),
      newDisplay: displayOf(field, value),
    });
  };

  if (rule.callStatus.mode === 'fixed' && rule.callStatus.value != null) addOp('kls_callstatus', 'Anrufstatus', rule.callStatus.value);
  if (rule.ratingCategory && conditionHolds(rule.ratingCategory.condition, lead, input)) {
    addOp('kls_rating_category', 'Bewertung', rule.ratingCategory.value);
  }
  for (const action of rule.fieldActions) {
    if (!action.field || !['set', 'add_to_multiselect', 'set_if_empty'].includes(action.kind)) continue;
    if (!conditionHolds(action.condition, lead, input)) continue;
    const value = action.valueFrom ? (input[action.valueFrom] ?? null) : (action.value ?? null);
    if (value == null && action.kind !== 'set') continue;
    addOp(action.field, action.label ?? action.field, value, action.kind as FieldOp['mode']);
  }
  if (rule.setsOwnerToCaller && actor.crmUserId) addOp('ownerid', 'Besitzer', actor.crmUserId);

  const stateChanges: StateOp[] = [];
  if (rule.setsContacted && lead.statecode === STATE.OPEN && lead.statuscode === STATUS.NEW) {
    baseSnapshot[snapKey('lead', lead.leadid, 'statuscode')] = lead.statuscode;
    stateChanges.push({ id: nextId('state'), leadId: lead.leadid, statecode: STATE.OPEN, statuscode: STATUS.CONTACTED, label: 'Neu → Kontaktiert' });
  }

  const activities: ActivityOp[] = [];
  if (args.appointment) {
    activities.push({
      id: nextId('activity'),
      action: 'create',
      type: 'appointment',
      leadId: lead.leadid,
      subject: args.appointment.subject,
      text: args.appointment.text,
      direction: 'outgoing',
      start: args.appointment.start,
      end: args.appointment.end,
      to: args.appointment.to,
    });
  }
  if (args.email) {
    activities.push({
      id: nextId('activity'),
      action: 'create',
      type: 'email',
      leadId: lead.leadid,
      subject: args.email.subject,
      text: args.email.text,
      direction: 'outgoing',
      start: args.email.sentAt,
      end: args.email.sentAt,
      to: args.email.to,
    });
  }

  return {
    leadId: lead.leadid,
    callSessionId: args.callSessionId ?? null,
    kind: rule.key === 'meeting_booked' ? 'booking' : 'mail',
    ruleKey: rule.key,
    ruleVersion: rule.version,
    operations,
    activities,
    tasks: args.task ? [args.task] : [],
    notes: [],
    stateChanges,
    leadCreates: [],
    baseSnapshot,
  };
}

/** Change set after a cancellation: Markus picks the new call status himself (INTENT 6.11 «Anrufstatus erst nach Markus' Klick»). */
export function buildCallStatusChangeSet(
  lead: Pick<Lead, 'leadid' | 'kls_callstatus'>,
  callStatus: number,
  idPrefix = 'cancel',
): ChangeSetDraft {
  const ops: FieldOp[] =
    lead.kls_callstatus === callStatus
      ? []
      : [
          {
            id: `${idPrefix}-field-1`,
            entity: 'lead',
            entityId: lead.leadid,
            field: 'kls_callstatus',
            label: 'Anrufstatus',
            oldValue: lead.kls_callstatus,
            newValue: callStatus,
            mode: 'set',
            oldDisplay: displayOf('kls_callstatus', lead.kls_callstatus),
            newDisplay: displayOf('kls_callstatus', callStatus),
          },
        ];
  return {
    leadId: lead.leadid,
    callSessionId: null,
    kind: 'booking',
    ruleKey: null,
    ruleVersion: null,
    operations: ops,
    activities: [],
    tasks: [],
    notes: [],
    stateChanges: [],
    leadCreates: [],
    baseSnapshot: { [snapKey('lead', lead.leadid, 'kls_callstatus')]: lead.kls_callstatus },
  };
}

/** Call statuses Markus may choose after a cancellation. */
export const CANCELLATION_CALL_STATUSES: number[] = [
  CALL_STATUS.CALLBACK_TODAY,
  CALL_STATUS.CALLBACK_TOMORROW,
  CALL_STATUS.CALLBACK_7_DAYS,
  CALL_STATUS.CALLBACK_31_DAYS,
  CALL_STATUS.WAITING,
  CALL_STATUS.CALLBACK_3_6_MONTHS,
];

/** Add working days (Mon–Fri, no holidays) in `tz`, keeping the wall-clock time («nach 3 Arbeitstagen»). */
export function addWorkingDays(date: Date, days: number, timeZone = DEFAULT_TZ): Date {
  let iso = localIsoDate(date, timeZone);
  const hhmm = localHhmm(date, timeZone);
  let left = days;
  while (left > 0) {
    iso = addDaysIso(iso, 1);
    const wd = weekdayOfIso(iso);
    if (wd !== 0 && wd !== 6) left--;
  }
  return atLocalTime(iso, hhmm, timeZone);
}

// =====================================================================================================================
// Week view helpers (UI)
// =====================================================================================================================

/** Monday … Friday of the week containing `isoDate`. */
export function workWeekDays(isoDate: IsoDate): IsoDate[] {
  const monday = mondayOfIso(isoDate);
  return [0, 1, 2, 3, 4].map((i) => addDaysIso(monday, i));
}

/** Group slots by local date. */
export function groupSlotsByDay(slots: Slot[], timeZone = DEFAULT_TZ): Map<IsoDate, Slot[]> {
  const map = new Map<IsoDate, Slot[]>();
  for (const s of slots) {
    const d = localIsoDate(s.start, timeZone);
    map.set(d, [...(map.get(d) ?? []), s]);
  }
  return map;
}
