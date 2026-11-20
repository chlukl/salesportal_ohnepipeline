/**
 * Dashboard service (INTENT 6.12): loads calls (CRM `kls_anrufergebnis` per call), leads, bookings and calendars and
 * turns them into a `DashboardReport` with the pure functions from stats.ts.
 */
import {
  CANTONS,
  EMPLOYEE_BANDS,
  GRADE_LABELS,
  GRADES,
  ORG_TYPE_LABELS,
  RESULT_GROUP_LABELS,
  employeeBandLabel,
  optionLabel,
  zurichTime,
  type DashboardBreakdown,
  type DashboardDimension,
  type DashboardRange,
  type DashboardReport,
  type Lead,
  type PhoneCall,
} from '@sales-portal/shared';
import { and, gte, inArray, lt, or } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { bookings, users } from '../../db/schema';
import type { Adapters } from '../../integrations';
import { getSetting } from '../../lib/settings';
import {
  MIN_N,
  REJECTION_GROUPS,
  activityByDay,
  activityByWeek,
  addDaysIso,
  bestWorst,
  breakdown,
  breakdownRow,
  daysOf,
  freeSlotStarts,
  isConversation,
  isReached,
  leadOutcomes,
  periodFor,
  reachabilityHeatmap,
  resultGroupTotals,
  resultGroupsByWeek,
  scoreSeparation,
  weekLabel,
  weekStartIso,
  weeksOf,
} from './stats';

type KeyFn = (lead: Lead) => { key: string; label: string } | null;

const DIMENSIONS: { dimension: DashboardDimension; label: string; keyOf: KeyFn; order?: string[] }[] = [
  {
    dimension: 'industry',
    label: 'Branche',
    keyOf: (l) => (l.kls_industry ? { key: l.kls_industry, label: l.kls_industry } : { key: 'unknown', label: 'ohne Branche' }),
  },
  {
    dimension: 'customIndustry',
    label: 'Eigene Kategorie',
    keyOf: (l) => (l.kls_custom_industry ? { key: l.kls_custom_industry, label: l.kls_custom_industry } : { key: 'unknown', label: 'ohne Kategorie' }),
  },
  {
    dimension: 'orgType',
    label: 'Organisationstyp',
    keyOf: (l) => ({ key: l.orgType, label: ORG_TYPE_LABELS[l.orgType] }),
    order: ['private', 'public', 'association', 'unknown'],
  },
  {
    dimension: 'employeeBand',
    label: 'Mitarbeitende',
    keyOf: (l) => ({ key: l.employeeBand, label: `${employeeBandLabel(l.employeeBand)}${l.employeeBand === 'unknown' ? '' : ' MA'}` }),
    order: EMPLOYEE_BANDS.map((b) => b.key),
  },
  {
    dimension: 'grade',
    label: 'Grade',
    keyOf: (l) => ({ key: l.grade, label: GRADE_LABELS[l.grade] }),
    order: [...GRADES],
  },
  {
    dimension: 'region',
    label: 'Region (Kanton)',
    keyOf: (l) => {
      const c = l.address1_stateorprovince?.trim();
      return c ? { key: c, label: CANTONS[c] ?? c } : { key: 'unknown', label: 'unbekannt' };
    },
  },
  {
    dimension: 'source',
    label: 'Quelle / Kampagne',
    keyOf: (l) => {
      if ((l.campaign.inCampaign || l.campaign.fromCampaign) && l.campaign.campaignName) {
        return { key: `campaign:${l.campaign.campaignName}`, label: `Kampagne «${l.campaign.campaignName}»` };
      }
      if (l.leadsourcecode != null) return { key: `source:${l.leadsourcecode}`, label: optionLabel('leadsourcecode', l.leadsourcecode) ?? 'unbekannt' };
      return null;
    },
  },
];

export interface ReportOptions {
  range: DashboardRange;
  /** Any date inside the period (YYYY-MM-DD, Zurich); default today. */
  anchor?: string;
  now: Date;
  minN?: number;
}

export async function buildReport(db: Db, adapters: Adapters, options: ReportOptions): Promise<DashboardReport> {
  const minN = options.minN ?? MIN_N;
  const period = periodFor(options.range, options.anchor ?? options.now);
  const allCalls = await adapters.crm.listPhoneCalls({
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    direction: 'outgoing',
    limit: 50_000,
  });
  const calls = allCalls.filter((c) => {
    const t = Date.parse(c.start);
    return t >= period.from.getTime() && t < period.to.getTime();
  });

  // ---- activity ----------------------------------------------------------------------------------------------------
  const days = daysOf(period.startIso, period.endIso);
  const weeks = weeksOf(period.startIso, period.endIso);
  const activity: DashboardReport['activity'] = {
    calls: calls.length,
    reached: calls.filter(isReached).length,
    conversations: calls.filter(isConversation).length,
    days: activityByDay(calls, days),
    weeks: activityByWeek(calls, weeks),
    heatmap: reachabilityHeatmap(calls),
  };

  // ---- results (per call) and outcomes (per lead) ------------------------------------------------------------------
  const outcomes = leadOutcomes(calls);
  const leads = new Map<string, Lead>();
  if (outcomes.size) {
    for (const l of await adapters.crm.getLeads([...outcomes.keys()])) leads.set(l.leadid, l);
  }
  const totals = resultGroupTotals(calls);
  const allOutcomes = [...outcomes.values()];
  const overall = breakdownRow('all', 'alle', allOutcomes, minN);
  const reasons = REJECTION_GROUPS.map((key) => ({ key, label: RESULT_GROUP_LABELS[key], count: totals.get(key) ?? 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  const results: DashboardReport['results'] = {
    weeks: resultGroupsByWeek(calls, weeks),
    totals: [...totals.entries()].map(([key, count]) => ({ key, label: RESULT_GROUP_LABELS[key], count })),
    leadsReached: overall.n,
    appointment: overall.appointment,
    rejection: overall.rejection,
    reasons,
  };

  // ---- where it works ----------------------------------------------------------------------------------------------
  const impact: DashboardBreakdown[] = DIMENSIONS.map((d) => {
    const rows = breakdown(outcomes, leads, d.keyOf, minN, d.order);
    return { dimension: d.dimension, label: d.label, rows, ...bestWorst(rows) };
  });

  const gradeRows = impact.find((i) => i.dimension === 'grade')?.rows ?? [];
  const scoreCheck: DashboardReport['scoreCheck'] = { rows: gradeRows, ...scoreSeparation(gradeRows) };

  return {
    period: {
      range: period.range,
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      label: period.label,
      anchor: period.anchor,
      prevAnchor: period.prevAnchor,
      nextAnchor: period.to.getTime() > options.now.getTime() ? null : period.nextAnchor,
    },
    generatedAt: options.now.toISOString(),
    minN,
    activity,
    results,
    impact,
    meetings: await meetingStats(db, adapters, period.from, period.to, options.now),
    scoreCheck,
  };
}

/** First meetings per sales (share «Zusatzcall Lukas»), cancellations / moves, free capacity of the next 4 weeks. */
export async function meetingStats(db: Db, adapters: Adapters, from: Date, to: Date, now: Date): Promise<DashboardReport['meetings']> {
  const rows = await db
    .select({
      id: bookings.id,
      salesUserId: bookings.salesUserId,
      extraCall: bookings.extraCall,
      status: bookings.status,
      createdAt: bookings.createdAt,
      updatedAt: bookings.updatedAt,
    })
    .from(bookings)
    .where(
      or(
        and(gte(bookings.createdAt, from), lt(bookings.createdAt, to)),
        and(inArray(bookings.status, ['cancelled', 'rescheduled']), gte(bookings.updatedAt, from), lt(bookings.updatedAt, to)),
      ),
    );
  const booked = rows.filter((r) => r.createdAt >= from && r.createdAt < to);
  const userIds = [...new Set(booked.map((b) => b.salesUserId).filter((x): x is string => !!x))];
  const names = new Map(
    (userIds.length ? await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, userIds)) : []).map((u) => [u.id, u.name]),
  );
  const bySales = new Map<string, { userId: string | null; name: string; booked: number; extraCalls: number }>();
  for (const b of booked) {
    const key = b.salesUserId ?? 'none';
    const row = bySales.get(key) ?? { userId: b.salesUserId, name: (b.salesUserId && names.get(b.salesUserId)) || 'ohne Sales', booked: 0, extraCalls: 0 };
    row.booked += 1;
    if (b.extraCall) row.extraCalls += 1;
    bySales.set(key, row);
  }
  const extraCalls = booked.filter((b) => b.extraCall).length;
  const inRange = (d: Date) => d >= from && d < to;

  // Capacity: current week + 3 (from the calendar, like the old weekly report).
  const rules = await getSetting(db, 'booking.rules');
  const nameByEmail = new Map(
    (await db.select({ email: users.email, name: users.displayName }).from(users).where(inArray(users.email, [rules.defaultSalesEmail, rules.specialistEmail]))).map(
      (u) => [u.email, u.name],
    ),
  );
  const capacityNames = {
    sales: nameByEmail.get(rules.defaultSalesEmail) ?? rules.defaultSalesEmail.split('@')[0],
    specialist: nameByEmail.get(rules.specialistEmail) ?? rules.specialistEmail.split('@')[0],
  };
  let capacity: DashboardReport['meetings']['capacity'] = null;
  let capacityError: string | null = null;
  try {
    const firstWeek = weekStartIso(now);
    const capWeeks = [0, 1, 2, 3].map((i) => addDaysIso(firstWeek, i * 7));
    const fromIso = zurichTime(firstWeek, '00:00').toISOString();
    const toIso = zurichTime(addDaysIso(firstWeek, 28), '00:00').toISOString();
    const schedules = await adapters.calendar.getSchedule([rules.defaultSalesEmail, rules.specialistEmail], fromIso, toIso);
    const busyOf = (email: string) => {
      const s = schedules.find((x) => x.email.toLowerCase() === email.toLowerCase());
      if (!s || s.error) throw new Error('schedule missing');
      return s.busy;
    };
    const salesBusy = busyOf(rules.defaultSalesEmail);
    const specialistBusy = busyOf(rules.specialistEmail);
    capacity = capWeeks.map((w) => ({
      week: w,
      label: weekLabel(w),
      sales: freeSlotStarts(w, [salesBusy], rules, now).length,
      specialist: freeSlotStarts(w, [specialistBusy], rules, now).length,
      joint: freeSlotStarts(w, [salesBusy, specialistBusy], rules, now).length,
    }));
  } catch {
    capacityError = 'Kalender gerade nicht erreichbar – freie Kapazität kann nicht berechnet werden.';
  }

  return {
    total: booked.length,
    bySales: [...bySales.values()].sort((a, b) => b.booked - a.booked),
    extraCalls,
    extraCallShare: booked.length ? extraCalls / booked.length : null,
    cancelled: rows.filter((r) => r.status === 'cancelled' && inRange(r.updatedAt)).length,
    rescheduled: rows.filter((r) => r.status === 'rescheduled' && inRange(r.updatedAt)).length,
    capacity,
    capacityNames,
    capacityError,
  };
}

/** Kept for compatibility with the foundation placeholder (GET /api/dashboard/summary). */
export async function getSummary(adapters: Adapters, now = new Date()): Promise<{ callsLast7Days: number; conversationsLast7Days: number }> {
  const from = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const calls: PhoneCall[] = await adapters.crm.listPhoneCalls({ from, direction: 'outgoing', limit: 10_000 });
  return { callsLast7Days: calls.length, conversationsLast7Days: calls.filter(isConversation).length };
}

