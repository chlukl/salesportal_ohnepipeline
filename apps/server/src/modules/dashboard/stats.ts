/**
 * Dashboard statistics (INTENT 6.12) – pure functions, no I/O (tested in dashboard.test.ts).
 *
 * Definitions (shown in the UI as well):
 * - «erreicht»: call with a result other than «Nicht erreicht»/«Falsche Nummer»; older calls without result count as
 *   reached when they lasted ≥ 4 min (INTENT 5 «echter Kontakt»).
 * - «Gespräch»: call ≥ 4 min.
 * - Termin = «Termin gebucht» or «3 Vorschläge gesendet» (like the Prod analysis «Termin vereinbart/vorgeschlagen»).
 * - Absage = Kein Bedarf, Hat Partner, Intern/Konzern, Zu klein, Nicht mehr kontaktieren, Mitbewerber.
 * - Quoten «Wo es wirkt»/«Score-Check» are per reached lead: a lead counts once; an appointment in the period always wins,
 *   otherwise the latest reached result decides. Rates only from n ≥ 10 (with Wilson 95% interval).
 */
import {
  NOT_REACHED_RESULT_CODES,
  RESULT_GROUP_KEYS,
  asZurichWallClock,
  resultGroupByCode,
  zurichDate,
  zurichTime,
  type BookingRules,
  type BusyInterval,
  type DashboardBreakdownRow,
  type DashboardRange,
  type IsoDate,
  type PhoneCall,
  type RateValue,
  type ResultGroupKey,
} from '@sales-portal/shared';

export const MIN_N = 10;
export const CONVERSATION_MIN_SEC = 240;
export const APPOINTMENT_GROUPS: readonly ResultGroupKey[] = ['meeting_booked', 'proposals_sent'];
export const REJECTION_GROUPS: readonly ResultGroupKey[] = ['no_need', 'has_partner', 'internal_group', 'too_small', 'do_not_contact', 'competitor'];

// ---------------------------------------------------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------------------------------------------------

/** Wilson score interval (default 95%). n = 0 → null. */
export function wilson(hits: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** Rate with interval; below `minN` only the counts are reported («zu wenig Daten»). */
export function rateValue(hits: number, n: number, minN = MIN_N): RateValue {
  if (n < minN || n === 0) return { hits, n, rate: null, ci: null };
  return { hits, n, rate: hits / n, ci: wilson(hits, n) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------------------------------

type CallLike = Pick<PhoneCall, 'resultCode' | 'durationSec'>;

export function isConversation(call: CallLike): boolean {
  return (call.durationSec ?? 0) >= CONVERSATION_MIN_SEC;
}

export function isReached(call: CallLike): boolean {
  if (call.resultCode != null) return !NOT_REACHED_RESULT_CODES.includes(call.resultCode);
  return isConversation(call);
}

export type LeadOutcomeKind = 'appointment' | 'rejection' | 'open';

export interface LeadOutcome {
  leadId: string;
  outcome: LeadOutcomeKind;
  /** Result group that decided the outcome. */
  group: ResultGroupKey;
}

/**
 * One outcome per reached lead (calls with a result only). Appointment wins; otherwise the latest reached result.
 */
export function leadOutcomes(calls: Pick<PhoneCall, 'leadId' | 'resultCode' | 'durationSec' | 'start'>[]): Map<string, LeadOutcome> {
  const byLead = new Map<string, { start: string; group: ResultGroupKey }[]>();
  for (const c of calls) {
    if (!c.leadId || c.resultCode == null || !isReached(c)) continue;
    const group = resultGroupByCode(c.resultCode);
    if (!group) continue;
    const list = byLead.get(c.leadId) ?? [];
    list.push({ start: c.start, group });
    byLead.set(c.leadId, list);
  }
  const out = new Map<string, LeadOutcome>();
  for (const [leadId, list] of byLead) {
    list.sort((a, b) => a.start.localeCompare(b.start));
    const appointment = list.find((x) => APPOINTMENT_GROUPS.includes(x.group));
    if (appointment) {
      out.set(leadId, { leadId, outcome: 'appointment', group: appointment.group });
      continue;
    }
    const last = list[list.length - 1];
    out.set(leadId, { leadId, outcome: REJECTION_GROUPS.includes(last.group) ? 'rejection' : 'open', group: last.group });
  }
  return out;
}

export function breakdownRow(key: string, label: string, outcomes: LeadOutcome[], minN = MIN_N): DashboardBreakdownRow {
  const n = outcomes.length;
  const appointments = outcomes.filter((o) => o.outcome === 'appointment').length;
  const rejections = outcomes.filter((o) => o.outcome === 'rejection').length;
  return {
    key,
    label,
    n,
    appointment: rateValue(appointments, n, minN),
    rejection: rateValue(rejections, n, minN),
    tooFew: n < minN,
  };
}

/** Group outcomes by a lead attribute. Leads without data (`keyOf` → null) land in «unbekannt». Sorted by n desc. */
export function breakdown<L>(
  outcomes: Map<string, LeadOutcome>,
  leads: Map<string, L>,
  keyOf: (lead: L) => { key: string; label: string } | null,
  minN = MIN_N,
  order?: string[],
): DashboardBreakdownRow[] {
  const groups = new Map<string, { label: string; items: LeadOutcome[] }>();
  for (const o of outcomes.values()) {
    const lead = leads.get(o.leadId);
    const k = (lead ? keyOf(lead) : null) ?? { key: 'unknown', label: 'unbekannt' };
    const g = groups.get(k.key) ?? { label: k.label, items: [] };
    g.items.push(o);
    groups.set(k.key, g);
  }
  const rows = [...groups.entries()].map(([key, g]) => breakdownRow(key, g.label, g.items, minN));
  if (order) {
    const pos = (k: string) => {
      const i = order.indexOf(k);
      return i === -1 ? order.length : i;
    };
    return rows.sort((a, b) => pos(a.key) - pos(b.key) || b.n - a.n);
  }
  return rows.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'de-CH'));
}

/** Best and worst row by appointment rate among rows with enough data; needs at least two such rows. */
export function bestWorst(rows: DashboardBreakdownRow[]): { best: DashboardBreakdownRow | null; worst: DashboardBreakdownRow | null } {
  const eligible = rows.filter((r) => !r.tooFew && r.appointment.rate != null && r.key !== 'unknown');
  if (eligible.length < 2) return { best: null, worst: null };
  const sorted = [...eligible].sort((a, b) => (b.appointment.rate ?? 0) - (a.appointment.rate ?? 0) || b.n - a.n);
  return { best: sorted[0], worst: sorted[sorted.length - 1] };
}

/** Score-Check: does the grade separate? Rows in grade order A → D (unrated ignored). */
export function scoreSeparation(rows: DashboardBreakdownRow[]): { separates: boolean | null; monotonic: boolean | null } {
  const graded = ['A', 'B', 'C', 'D']
    .map((g) => rows.find((r) => r.key === g))
    .filter((r): r is DashboardBreakdownRow => !!r && !r.tooFew && r.appointment.rate != null);
  if (graded.length < 2) return { separates: null, monotonic: null };
  let monotonic = true;
  for (let i = 1; i < graded.length; i++) {
    if ((graded[i].appointment.rate ?? 0) > (graded[i - 1].appointment.rate ?? 0)) monotonic = false;
  }
  const first = graded[0].appointment.ci;
  const last = graded[graded.length - 1].appointment.ci;
  const disjoint = !!first && !!last && first.low > last.high;
  return { separates: monotonic && disjoint, monotonic };
}

// ---------------------------------------------------------------------------------------------------------------------
// Time buckets (Europe/Zurich)
// ---------------------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function isoToUtcMidnight(iso: IsoDate): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function utcMidnightToIso(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function addDaysIso(iso: IsoDate, days: number): IsoDate {
  return utcMidnightToIso(new Date(isoToUtcMidnight(iso).getTime() + days * DAY_MS));
}

/** Monday of the Zurich calendar week of `date`. */
export function weekStartIso(date: Date | string): IsoDate {
  const iso = zurichDate(date);
  const dow = isoToUtcMidnight(iso).getUTCDay(); // 0 = Sunday
  return addDaysIso(iso, -((dow + 6) % 7));
}

/** ISO 8601 week number of a date (`YYYY-MM-DD`). */
export function isoWeekNumber(iso: IsoDate): number {
  const d = isoToUtcMidnight(iso);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
}

export function weekLabel(weekStart: IsoDate): string {
  return `KW ${isoWeekNumber(weekStart)}`;
}

/** 1 = Monday … 7 = Sunday and hour (0–23), both in Zurich time. */
export function zurichWeekdayHour(date: Date | string): { weekday: number; hour: number } {
  const wall = asZurichWallClock(date);
  const dow = wall.getDay();
  return { weekday: dow === 0 ? 7 : dow, hour: wall.getHours() };
}

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function fmtDay(iso: IsoDate): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export interface Period {
  range: DashboardRange;
  /** Inclusive start / exclusive end as Zurich dates. */
  startIso: IsoDate;
  endIso: IsoDate;
  from: Date;
  to: Date;
  label: string;
  anchor: IsoDate;
  prevAnchor: IsoDate;
  nextAnchor: IsoDate;
}

/** Calendar week (Mon–Sun), month or quarter containing `anchor` (Zurich). */
export function periodFor(range: DashboardRange, anchor: Date | string): Period {
  const iso = typeof anchor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : zurichDate(anchor);
  let startIso: IsoDate;
  let endIso: IsoDate;
  let label: string;
  const [y, m] = iso.split('-').map(Number);
  if (range === 'week') {
    const dow = isoToUtcMidnight(iso).getUTCDay();
    startIso = addDaysIso(iso, -((dow + 6) % 7));
    endIso = addDaysIso(startIso, 7);
    label = `${weekLabel(startIso)} · ${fmtDay(startIso)} – ${fmtDay(addDaysIso(endIso, -1))}`;
  } else if (range === 'month') {
    startIso = `${y}-${String(m).padStart(2, '0')}-01`;
    endIso = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    label = `${MONTHS[m - 1]} ${y}`;
  } else {
    const q = Math.floor((m - 1) / 3);
    const sm = q * 3 + 1;
    startIso = `${y}-${String(sm).padStart(2, '0')}-01`;
    endIso = sm + 3 > 12 ? `${y + 1}-01-01` : `${y}-${String(sm + 3).padStart(2, '0')}-01`;
    label = `${q + 1}. Quartal ${y}`;
  }
  return {
    range,
    startIso,
    endIso,
    from: zurichTime(startIso, '00:00'),
    to: zurichTime(endIso, '00:00'),
    label,
    anchor: startIso,
    prevAnchor: addDaysIso(startIso, -1),
    nextAnchor: endIso,
  };
}

/** Week starts (Mondays) touching [startIso, endIso). */
export function weeksOf(startIso: IsoDate, endIso: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  let w = weekStartIso(zurichTime(startIso, '12:00'));
  while (w < endIso) {
    out.push(w);
    w = addDaysIso(w, 7);
  }
  return out;
}

export function daysOf(startIso: IsoDate, endIso: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = startIso; d < endIso; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Activity aggregation
// ---------------------------------------------------------------------------------------------------------------------

type ActivityCall = Pick<PhoneCall, 'start' | 'resultCode' | 'durationSec'>;

export function activityByDay(calls: ActivityCall[], days: IsoDate[]) {
  const map = new Map(days.map((d) => [d, { date: d, calls: 0, reached: 0, conversations: 0 }]));
  for (const c of calls) {
    const row = map.get(zurichDate(c.start));
    if (!row) continue;
    row.calls += 1;
    if (isReached(c)) row.reached += 1;
    if (isConversation(c)) row.conversations += 1;
  }
  return [...map.values()];
}

export function activityByWeek(calls: ActivityCall[], weeks: IsoDate[]) {
  const map = new Map(weeks.map((w) => [w, { week: w, label: weekLabel(w), calls: 0, reached: 0, conversations: 0 }]));
  for (const c of calls) {
    const row = map.get(weekStartIso(c.start));
    if (!row) continue;
    row.calls += 1;
    if (isReached(c)) row.reached += 1;
    if (isConversation(c)) row.conversations += 1;
  }
  return [...map.values()];
}

/** Reachability heatmap: calls and reached calls per weekday × hour (only cells with calls). */
export function reachabilityHeatmap(calls: ActivityCall[]): { weekday: number; hour: number; calls: number; reached: number }[] {
  const map = new Map<string, { weekday: number; hour: number; calls: number; reached: number }>();
  for (const c of calls) {
    const { weekday, hour } = zurichWeekdayHour(c.start);
    const key = `${weekday}:${hour}`;
    const cell = map.get(key) ?? { weekday, hour, calls: 0, reached: 0 };
    cell.calls += 1;
    if (isReached(c)) cell.reached += 1;
    map.set(key, cell);
  }
  return [...map.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
}

/** Result groups per week (calls with a result). */
export function resultGroupsByWeek(calls: Pick<PhoneCall, 'start' | 'resultCode'>[], weeks: IsoDate[]) {
  const map = new Map(weeks.map((w) => [w, { week: w, label: weekLabel(w), counts: {} as Partial<Record<ResultGroupKey, number>> }]));
  for (const c of calls) {
    const group = resultGroupByCode(c.resultCode);
    if (!group) continue;
    const row = map.get(weekStartIso(c.start));
    if (!row) continue;
    row.counts[group] = (row.counts[group] ?? 0) + 1;
  }
  return [...map.values()];
}

export function resultGroupTotals(calls: Pick<PhoneCall, 'resultCode'>[]): Map<ResultGroupKey, number> {
  const out = new Map<ResultGroupKey, number>();
  for (const c of calls) {
    const g = resultGroupByCode(c.resultCode);
    if (g) out.set(g, (out.get(g) ?? 0) + 1);
  }
  return new Map(RESULT_GROUP_KEYS.filter((k) => out.has(k)).map((k) => [k, out.get(k)!]));
}

// ---------------------------------------------------------------------------------------------------------------------
// Free capacity (like the old weekly report): free meeting starts per week
// ---------------------------------------------------------------------------------------------------------------------

const BLOCKING: BusyInterval['status'][] = ['busy', 'tentative', 'oof'];

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function* hhmmRange(from: string, to: string, stepMin: number): Generator<string> {
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  for (let m = toMin(from); m <= toMin(to); m += Math.max(5, stepMin)) {
    yield `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }
}

/**
 * Meeting start times (Mon–Fri, start windows, step) in the week where every given calendar is free for
 * buffer before + meeting + buffer after (INTENT 6.6: buffers for all, at every start time). Starts before `now` are skipped.
 */
export function freeSlotStarts(weekStart: IsoDate, calendars: BusyInterval[][], rules: BookingRules, now: Date): Date[] {
  const out: Date[] = [];
  const busy = calendars.map((list) =>
    list.filter((b) => BLOCKING.includes(b.status)).map((b) => [Date.parse(b.start), Date.parse(b.end)] as const),
  );
  for (let i = 0; i < 5; i++) {
    const day = addDaysIso(weekStart, i);
    const blocked = rules.blockedWindows.map((w) => [zurichTime(day, w.from).getTime(), zurichTime(day, w.to).getTime()] as const);
    for (const win of rules.startWindows) {
      for (const hhmm of hhmmRange(win.from, win.to, rules.slotStepMinutes)) {
        const start = zurichTime(day, hhmm).getTime();
        if (start <= now.getTime()) continue;
        const end = start + rules.durationMinutes * 60_000;
        if (blocked.some(([bs, be]) => overlaps(start, end, bs, be))) continue;
        const gStart = start - rules.bufferBeforeMinutes * 60_000;
        const gEnd = end + rules.bufferAfterMinutes * 60_000;
        if (busy.every((list) => !list.some(([bs, be]) => overlaps(gStart, gEnd, bs, be)))) out.push(new Date(start));
      }
    }
  }
  return out;
}
