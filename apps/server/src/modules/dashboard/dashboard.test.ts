import { RESULT_GROUP_CODES, zurichDate, zurichTime, type BookingRules, type DashboardReport, type PhoneCall } from '@sales-portal/shared';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/helpers';
import { DEFAULT_BOOKING_RULES } from '../../db/seed/defaults';
import { auditLog, bookings, mockCrmActivities, mockCrmLeads, mockOutbox } from '../../db/schema';
import { isWeeklyReportDue, previousWeekStart, sendWeeklyReport, weeklyReportText } from './report';
import {
  bestWorst,
  breakdown,
  breakdownRow,
  freeSlotStarts,
  isConversation,
  isReached,
  isoWeekNumber,
  leadOutcomes,
  periodFor,
  rateValue,
  reachabilityHeatmap,
  scoreSeparation,
  weekStartIso,
  wilson,
  zurichWeekdayHour,
  type LeadOutcome,
} from './stats';

const C = RESULT_GROUP_CODES;

function call(p: Partial<PhoneCall> & { leadId: string; start: string }): PhoneCall {
  return {
    id: `${p.leadId}-${p.start}`,
    leadName: null,
    companyName: null,
    direction: 'outgoing',
    subject: null,
    text: null,
    phoneNumber: null,
    phoneE164: null,
    ownerId: null,
    ownerName: null,
    end: null,
    durationSec: null,
    resultCode: null,
    interest: null,
    transcriptLink: null,
    ...p,
  };
}

describe('rates', () => {
  it('computes the Wilson 95% interval', () => {
    const ci = wilson(5, 10)!;
    expect(ci.low).toBeCloseTo(0.2366, 3);
    expect(ci.high).toBeCloseTo(0.7634, 3);
    expect(wilson(0, 20)!.low).toBe(0);
    expect(wilson(20, 20)!.high).toBe(1);
    expect(wilson(0, 0)).toBeNull();
  });

  it('shows no rate below n = 10 («zu wenig Daten»)', () => {
    expect(rateValue(3, 9)).toEqual({ hits: 3, n: 9, rate: null, ci: null });
    const ok = rateValue(3, 10);
    expect(ok.rate).toBeCloseTo(0.3);
    expect(ok.ci).not.toBeNull();
  });
});

describe('call classification', () => {
  it('reached = result other than «Nicht erreicht»/«Falsche Nummer»; legacy calls by duration ≥ 4 min', () => {
    expect(isReached({ resultCode: C.not_reached, durationSec: 600 })).toBe(false);
    expect(isReached({ resultCode: C.wrong_number, durationSec: 30 })).toBe(false);
    expect(isReached({ resultCode: C.no_need, durationSec: 20 })).toBe(true);
    expect(isReached({ resultCode: null, durationSec: 240 })).toBe(true);
    expect(isReached({ resultCode: null, durationSec: 239 })).toBe(false);
    expect(isConversation({ resultCode: null, durationSec: 240 })).toBe(true);
  });

  it('one outcome per lead: appointment wins, otherwise the latest reached result', () => {
    const out = leadOutcomes([
      call({ leadId: 'a', start: '2026-11-02T09:00:00Z', resultCode: C.meeting_booked }),
      call({ leadId: 'a', start: '2026-11-05T09:00:00Z', resultCode: C.no_need }),
      call({ leadId: 'b', start: '2026-11-02T09:00:00Z', resultCode: C.no_need }),
      call({ leadId: 'b', start: '2026-11-04T09:00:00Z', resultCode: C.callback }),
      call({ leadId: 'c', start: '2026-11-02T09:00:00Z', resultCode: C.callback }),
      call({ leadId: 'c', start: '2026-11-03T09:00:00Z', resultCode: C.has_partner }),
      call({ leadId: 'd', start: '2026-11-02T09:00:00Z', resultCode: C.not_reached }),
      call({ leadId: 'e', start: '2026-11-02T09:00:00Z', resultCode: null, durationSec: 900 }),
      call({ leadId: 'f', start: '2026-11-02T09:00:00Z', resultCode: C.proposals_sent }),
    ]);
    expect(out.get('a')).toMatchObject({ outcome: 'appointment', group: 'meeting_booked' });
    expect(out.get('b')).toMatchObject({ outcome: 'open', group: 'callback' });
    expect(out.get('c')).toMatchObject({ outcome: 'rejection', group: 'has_partner' });
    expect(out.has('d')).toBe(false);
    expect(out.has('e')).toBe(false);
    expect(out.get('f')?.outcome).toBe('appointment');
  });
});

function outcomes(prefix: string, appointments: number, rejections: number, open: number): LeadOutcome[] {
  const list: LeadOutcome[] = [];
  let i = 0;
  for (let k = 0; k < appointments; k++) list.push({ leadId: `${prefix}${i++}`, outcome: 'appointment', group: 'meeting_booked' });
  for (let k = 0; k < rejections; k++) list.push({ leadId: `${prefix}${i++}`, outcome: 'rejection', group: 'no_need' });
  for (let k = 0; k < open; k++) list.push({ leadId: `${prefix}${i++}`, outcome: 'open', group: 'callback' });
  return list;
}

describe('where it works', () => {
  const all = [...outcomes('bau', 2, 6, 4), ...outcomes('elektro', 5, 2, 3), ...outcomes('chemie', 1, 1, 0), ...outcomes('x', 4, 4, 4)];
  const map = new Map(all.map((o) => [o.leadId, o]));
  const leads = new Map(
    all.map((o) => [o.leadId, { industry: o.leadId.startsWith('bau') ? 'Bau' : o.leadId.startsWith('elektro') ? 'Elektro' : o.leadId.startsWith('chemie') ? 'Chemie' : null }]),
  );
  const rows = breakdown(map, leads, (l) => (l.industry ? { key: l.industry, label: l.industry } : null));

  it('groups by attribute, marks groups below n = 10', () => {
    const bau = rows.find((r) => r.key === 'Bau')!;
    expect(bau.n).toBe(12);
    expect(bau.appointment.rate).toBeCloseTo(2 / 12);
    expect(bau.rejection.rate).toBeCloseTo(6 / 12);
    const chemie = rows.find((r) => r.key === 'Chemie')!;
    expect(chemie.tooFew).toBe(true);
    expect(chemie.appointment.rate).toBeNull();
    expect(rows.find((r) => r.key === 'unknown')?.n).toBe(12);
  });

  it('best/worst only among groups with n ≥ 10, never «unbekannt»', () => {
    const { best, worst } = bestWorst(rows);
    expect(best?.key).toBe('Elektro');
    expect(worst?.key).toBe('Bau');
    expect(bestWorst(rows.filter((r) => r.key !== 'Elektro'))).toEqual({ best: null, worst: null });
  });

  it('score check: separates when rates fall A→D and intervals of best/worst do not overlap', () => {
    const A = breakdownRow('A', 'A', outcomes('a', 12, 4, 4));
    const B = breakdownRow('B', 'B', outcomes('b', 4, 8, 8));
    const D = breakdownRow('D', 'D', outcomes('d', 0, 15, 5));
    expect(scoreSeparation([A, B, D])).toEqual({ separates: true, monotonic: true });
    const Bhigh = breakdownRow('B', 'B', outcomes('b', 18, 1, 1));
    expect(scoreSeparation([A, Bhigh, D])).toEqual({ separates: false, monotonic: false });
    expect(scoreSeparation([A, breakdownRow('D', 'D', outcomes('d', 0, 3, 3))])).toEqual({ separates: null, monotonic: null });
  });
});

describe('time buckets (Europe/Zurich)', () => {
  it('week / month / quarter periods', () => {
    const w = periodFor('week', '2026-11-20');
    expect(w.startIso).toBe('2026-11-16');
    expect(w.endIso).toBe('2026-11-23');
    expect(w.label).toContain('KW 47');
    expect(w.from.toISOString()).toBe('2026-11-15T23:00:00.000Z');
    expect(w.prevAnchor).toBe('2026-11-15');
    const m = periodFor('month', '2026-12-31');
    expect([m.startIso, m.endIso, m.label]).toEqual(['2026-12-01', '2027-01-01', 'Dezember 2026']);
    const q = periodFor('quarter', '2026-11-20');
    expect([q.startIso, q.endIso, q.label]).toEqual(['2026-10-01', '2027-01-01', '4. Quartal 2026']);
  });

  it('ISO week numbers and Monday starts', () => {
    expect(isoWeekNumber('2026-01-01')).toBe(1);
    expect(isoWeekNumber('2026-11-20')).toBe(47);
    expect(isoWeekNumber('2027-01-01')).toBe(53);
    expect(weekStartIso('2026-11-22T23:30:00Z')).toBe('2026-11-23'); // Sunday 23:30 UTC = Monday 00:30 in Zurich
    expect(weekStartIso('2026-11-22T22:30:00Z')).toBe('2026-11-16'); // still Sunday in Zurich
  });

  it('heatmap uses Zurich weekday and hour', () => {
    expect(zurichWeekdayHour('2026-11-17T09:30:00Z')).toEqual({ weekday: 2, hour: 10 });
    expect(zurichWeekdayHour('2026-07-14T08:30:00Z')).toEqual({ weekday: 2, hour: 10 }); // summer time
    const cells = reachabilityHeatmap([
      call({ leadId: 'a', start: '2026-11-17T09:10:00Z', resultCode: C.no_need }),
      call({ leadId: 'b', start: '2026-11-17T09:40:00Z', resultCode: C.not_reached }),
      call({ leadId: 'c', start: '2026-11-18T13:05:00Z', resultCode: C.callback }),
    ]);
    expect(cells).toEqual([
      { weekday: 2, hour: 10, calls: 2, reached: 1 },
      { weekday: 3, hour: 14, calls: 1, reached: 1 },
    ]);
  });
});

describe('free capacity', () => {
  const rules: BookingRules = DEFAULT_BOOKING_RULES;
  const before = new Date('2026-11-20T12:00:00Z');

  it('counts start times in the windows (09:00–11:30, 14:00–16:00) for a free week', () => {
    expect(freeSlotStarts('2026-11-23', [[]], rules, before)).toHaveLength(5 * (6 + 5));
  });

  it('keeps 30 min buffer before and after for every calendar, also at 09:00/14:00', () => {
    const busy = [{ start: zurichTime('2026-11-23', '10:00').toISOString(), end: zurichTime('2026-11-23', '10:30').toISOString(), status: 'busy' as const }];
    // 09:30 (buffer until 10:30), 10:00 and 10:30 (buffer from 10:00) are blocked; 09:00 and 11:00 stay free.
    expect(freeSlotStarts('2026-11-23', [busy, []], rules, before)).toHaveLength(55 - 3);
    const early = [{ start: zurichTime('2026-11-24', '08:30').toISOString(), end: zurichTime('2026-11-24', '08:45').toISOString(), status: 'busy' as const }];
    expect(freeSlotStarts('2026-11-23', [early], rules, before)).toHaveLength(55 - 1);
    const free = [{ ...busy[0], status: 'free' as const }];
    expect(freeSlotStarts('2026-11-23', [free], rules, before)).toHaveLength(55);
  });

  it('skips start times in the past', () => {
    expect(freeSlotStarts('2026-11-23', [[]], rules, zurichTime('2026-11-27', '00:00'))).toHaveLength(11);
  });
});

describe('weekly report schedule', () => {
  it('is due from Monday 07:00 Zurich until sent for the previous week', () => {
    const mondayEarly = zurichTime('2026-11-23', '06:59');
    const mondayMorning = zurichTime('2026-11-23', '07:01');
    expect(previousWeekStart(mondayMorning)).toBe('2026-11-16');
    expect(isWeeklyReportDue(mondayEarly, null)).toBe(false);
    expect(isWeeklyReportDue(mondayMorning, null)).toBe(true);
    expect(isWeeklyReportDue(mondayMorning, '2026-11-09')).toBe(true);
    expect(isWeeklyReportDue(mondayMorning, '2026-11-16')).toBe(false);
    expect(isWeeklyReportDue(zurichTime('2026-11-25', '15:00'), '2026-11-09')).toBe(true); // catch up
  });
});

// =====================================================================================================================
// API (fastify.inject, in-memory PGlite, controlled mock CRM data)
// =====================================================================================================================

describe('dashboard API', () => {
  let t: TestApp;
  const base = new Date(Date.now() - 2 * 3_600_000);
  const anchor = zurichDate(base);

  beforeAll(async () => {
    t = await createTestApp();
    const db = t.ctx.db;
    // 12 «Bau» leads (3 meetings, 6 rejections, 3 open) + 3 «Chemie» leads, each with one reached call; plus «Nicht erreicht».
    const leads = [
      ...Array.from({ length: 12 }, (_, i) => ({ leadid: `T-BAU-${i}`, companyname: `Bau ${i} AG`, kls_industry: 'Bau', kls_leadscore: 75, numberofemployees: 60 })),
      ...Array.from({ length: 3 }, (_, i) => ({ leadid: `T-CHE-${i}`, companyname: `Chemie ${i} AG`, kls_industry: 'Chemie', kls_leadscore: 20, numberofemployees: 8 })),
    ];
    await db.insert(mockCrmLeads).values(leads);
    const results = [...Array(3).fill(C.meeting_booked), ...Array(6).fill(C.no_need), ...Array(3).fill(C.callback)];
    const acts = [
      ...results.map((code, i) => ({ activityid: `T-ACT-B${i}`, regardingLeadId: `T-BAU-${i}`, kls_anrufergebnis: code as number, durationSec: 300 })),
      ...[0, 1, 2].map((i) => ({ activityid: `T-ACT-C${i}`, regardingLeadId: `T-CHE-${i}`, kls_anrufergebnis: C.has_partner as number, durationSec: 120 })),
      ...[0, 1].map((i) => ({ activityid: `T-ACT-N${i}`, regardingLeadId: `T-CHE-${i}`, kls_anrufergebnis: C.not_reached as number, durationSec: 20 })),
    ].map((a) => ({ ...a, activitytype: 'phonecall' as const, direction: 'outgoing' as const, actualstart: base, createdon: base }));
    await db.insert(mockCrmActivities).values(acts);
    await db.insert(bookings).values([
      { bookingRef: 'T-1', leadId: 'T-BAU-0', startAt: base, endAt: base, subject: 's', createdBy: '00000000-0000-4000-8000-000000000002', salesUserId: '00000000-0000-4000-8000-000000000003', createdAt: base },
      { bookingRef: 'T-2', leadId: 'T-BAU-1', startAt: base, endAt: base, subject: 's', createdBy: '00000000-0000-4000-8000-000000000002', salesUserId: '00000000-0000-4000-8000-000000000001', extraCall: true, createdAt: base },
    ]);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('is never available for coldcallers – also not for an admin viewing as coldcaller', async () => {
    const markus = await t.login('markus');
    expect((await t.app.inject({ method: 'GET', url: '/api/dashboard/report', headers: { cookie: markus.cookie } })).statusCode).toBe(403);

    const lukas = await t.login('lukas', { fresh: true });
    await t.app.inject({ method: 'PUT', url: '/api/me/view-as', headers: { ...lukas.headers, 'content-type': 'application/json' }, payload: { role: 'coldcaller' } });
    expect((await t.app.inject({ method: 'GET', url: '/api/dashboard/report', headers: { cookie: lukas.cookie } })).statusCode).toBe(403);
    await t.app.inject({ method: 'DELETE', url: '/api/me/view-as', headers: lukas.headers });
    expect((await t.app.inject({ method: 'GET', url: '/api/dashboard/report', headers: { cookie: lukas.cookie } })).statusCode).toBe(200);
  });

  it('validates the query', async () => {
    const manuel = await t.login('manuel');
    const res = await t.app.inject({ method: 'GET', url: '/api/dashboard/report?range=year', headers: { cookie: manuel.cookie } });
    expect(res.statusCode).toBe(400);
    const bad = await t.app.inject({ method: 'GET', url: '/api/dashboard/report?anchor=2026-13-45', headers: { cookie: manuel.cookie } });
    expect(bad.statusCode).toBe(400);
  });

  it('builds activity, results, «Wo es wirkt», meetings and score check for sales', async () => {
    const nico = await t.login('nico');
    const res = await t.app.inject({ method: 'GET', url: `/api/dashboard/report?range=week&anchor=${anchor}`, headers: { cookie: nico.cookie } });
    expect(res.statusCode).toBe(200);
    const r = res.json() as DashboardReport;
    expect(r.activity.calls).toBe(17);
    expect(r.activity.reached).toBe(15);
    expect(r.activity.conversations).toBe(12);
    expect(r.activity.days.reduce((s, d) => s + d.calls, 0)).toBe(17);
    expect(r.results.leadsReached).toBe(15);
    expect(r.results.appointment.hits).toBe(3);
    expect(r.results.appointment.rate).toBeCloseTo(3 / 15);
    expect(r.results.rejection.hits).toBe(9);
    expect(r.results.reasons.map((x) => [x.key, x.count])).toEqual([
      ['no_need', 6],
      ['has_partner', 3],
    ]);
    const industry = r.impact.find((d) => d.dimension === 'industry')!;
    const bau = industry.rows.find((x) => x.key === 'Bau')!;
    expect(bau.n).toBe(12);
    expect(bau.appointment.rate).toBeCloseTo(0.25);
    expect(bau.appointment.ci).not.toBeNull();
    const chemie = industry.rows.find((x) => x.key === 'Chemie')!;
    expect(chemie.tooFew).toBe(true);
    expect(chemie.appointment.rate).toBeNull();
    expect(industry.best).toBeNull(); // only one group with n ≥ 10
    expect(r.scoreCheck.rows.find((x) => x.key === 'A')?.n).toBe(12);
    expect(r.meetings.total).toBe(2);
    expect(r.meetings.extraCalls).toBe(1);
    expect(r.meetings.extraCallShare).toBeCloseTo(0.5);
    expect(r.meetings.bySales.map((s) => s.name).sort()).toEqual(['Lukas', 'Manuel']);
    if (Date.parse(r.period.to) > Date.now()) expect(r.period.nextAnchor).toBeNull();
    // Aggregates only: no lead names / companies in the response.
    expect(res.body).not.toContain('Bau 0 AG');
  });

  it('weekly report: preview for dashboard roles, send only for admins, once per week, audited', async () => {
    const manuel = await t.login('manuel');
    const preview = await t.app.inject({ method: 'GET', url: '/api/dashboard/weekly-report/preview', headers: { cookie: manuel.cookie } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().subject).toContain('Wochenreport');
    expect((await t.app.inject({ method: 'POST', url: '/api/dashboard/weekly-report/send', headers: manuel.headers })).statusCode).toBe(403);

    const lukas = await t.login('lukas');
    const skipped = await t.app.inject({ method: 'POST', url: '/api/dashboard/weekly-report/send', headers: lukas.headers });
    expect(skipped.json()).toEqual({ status: 'skipped', reason: 'no_recipient' });

    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { ...lukas.headers, 'content-type': 'application/json' },
      payload: { weeklyReportRecipient: 'sales.demo@example.ch' },
    });
    expect(put.statusCode).toBe(200);

    const now = new Date();
    const first = await sendWeeklyReport(t.ctx.db, t.ctx.adapters.system(), now);
    expect(first).toMatchObject({ status: 'sent', recipient: 'sales.demo@example.ch', week: previousWeekStart(now) });
    expect(await sendWeeklyReport(t.ctx.db, t.ctx.adapters.system(), now)).toEqual({ status: 'skipped', reason: 'already_sent' });
    const forced = await t.app.inject({ method: 'POST', url: '/api/dashboard/weekly-report/send', headers: lukas.headers });
    expect(forced.json().status).toBe('sent');

    const mails = await t.ctx.db.select().from(mockOutbox).where(like(mockOutbox.subject, 'Wochenreport Sales-Portal%'));
    expect(mails.length).toBe(2);
    expect(mails[0].body).toContain('AKTIVITÄT');
    expect(mails[0].body).not.toMatch(/<[a-z]/i);
    const audits = await t.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'dashboard.weekly_report_sent'));
    expect(audits.length).toBe(2);
  });
});

describe('weekly report text', () => {
  it('reports «zu wenig Daten» below n and lists the numbers', () => {
    const report = {
      period: { range: 'week', from: '', to: '', label: 'KW 47', anchor: '2026-11-16', prevAnchor: '2026-11-15', nextAnchor: null },
      generatedAt: '2026-11-23T07:00:00.000Z',
      minN: 10,
      activity: { calls: 42, reached: 20, conversations: 9, days: [], weeks: [], heatmap: [] },
      results: { weeks: [], totals: [], leadsReached: 5, appointment: rateValue(1, 5), rejection: rateValue(2, 5), reasons: [] },
      impact: [],
      meetings: { total: 0, bySales: [], extraCalls: 0, extraCallShare: null, cancelled: 0, rescheduled: 0, capacity: null, capacityNames: { sales: 'Manuel', specialist: 'Nico' }, capacityError: 'x' },
      scoreCheck: { rows: [], separates: null, monotonic: null },
    } as DashboardReport;
    const { subject, body } = weeklyReportText(report);
    expect(subject).toBe('Wochenreport Sales-Portal – KW 47');
    expect(body).toContain('Anrufe: 42');
    expect(body).toContain('Gespräche ab 4 Min.: 9');
    expect(body).toContain('zu wenig Daten (1 von 5)');
  });
});
