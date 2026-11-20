/**
 * Weekly report (INTENT 6.12 / 7: replaces the «Wochenreport» flow). Built from the same numbers as the dashboard,
 * sent Monday morning for the previous week to the admin-configured address (plain text, MailAdapter → mock outbox).
 */
import { formatZurich, zurichTime, type DashboardReport, type RateValue, type WeeklyReportPreview } from '@sales-portal/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { syncState } from '../../db/schema';
import type { Adapters } from '../../integrations';
import { audit } from '../../lib/audit';
import { getExtraSetting } from '../admin/extraSettings';
import { buildReport } from './service';
import { addDaysIso, weekStartIso } from './stats';

export const WEEKLY_REPORT_STATE_KEY = 'dashboard.weeklyReport';
/** Earliest send time on Monday (Zurich). */
export const WEEKLY_REPORT_HOUR = '07:00';

export function pct(value: number | null | undefined): string {
  return value == null ? '–' : `${Math.round(value * 100)} %`;
}

function rateText(r: RateValue): string {
  if (r.rate == null) return `zu wenig Daten (${r.hits} von ${r.n})`;
  return `${pct(r.rate)} (${r.hits} von ${r.n}, 95 %-Bereich ${pct(r.ci?.low)}–${pct(r.ci?.high)})`;
}

/** Plain-text mail with the key numbers of the report (no HTML, CRM text only as values). */
export function weeklyReportText(report: DashboardReport): { subject: string; body: string } {
  const a = report.activity;
  const r = report.results;
  const m = report.meetings;
  const lines: string[] = [];
  lines.push(`Wochenreport Sales-Portal – ${report.period.label}`, '');
  lines.push('AKTIVITÄT');
  lines.push(`- Anrufe: ${a.calls}`);
  lines.push(`- Erreicht: ${a.reached}`);
  lines.push(`- Gespräche ab 4 Min.: ${a.conversations}`, '');
  lines.push('ERGEBNIS');
  lines.push(`- Erreichte Leads: ${r.leadsReached}`);
  lines.push(`- Terminquote: ${rateText(r.appointment)}`);
  lines.push(`- Absagequote: ${rateText(r.rejection)}`);
  if (r.reasons.length) lines.push(`- Gründe der Absagen: ${r.reasons.map((x) => `${x.label} ${x.count}`).join(', ')}`);
  if (r.totals.length) lines.push(`- Ergebnisse: ${r.totals.map((x) => `${x.label} ${x.count}`).join(', ')}`);
  lines.push('');
  lines.push('TERMINE');
  lines.push(`- Gebuchte Erstgespräche: ${m.total}${m.extraCallShare != null ? ` (davon Zusatzcalls ${m.extraCalls}, ${pct(m.extraCallShare)})` : ''}`);
  for (const s of m.bySales) lines.push(`  · ${s.name}: ${s.booked}${s.extraCalls ? ` (Zusatzcalls ${s.extraCalls})` : ''}`);
  lines.push(`- Absagen: ${m.cancelled} · Verschiebungen: ${m.rescheduled}`);
  if (m.capacity) {
    lines.push(`- Freie Termine (${m.capacityNames.sales} + ${m.capacityNames.specialist} gemeinsam):`);
    for (const w of m.capacity) lines.push(`  · ${w.label}: ${w.joint} (${m.capacityNames.sales} ${w.sales}, ${m.capacityNames.specialist} ${w.specialist})`);
  } else if (m.capacityError) {
    lines.push(`- Freie Kapazität: ${m.capacityError}`);
  }
  lines.push('');
  lines.push('WO ES WIRKT');
  for (const d of report.impact) {
    if (d.best && d.worst) {
      lines.push(`- ${d.label}: am besten ${d.best.label} ${pct(d.best.appointment.rate)}, am schwächsten ${d.worst.label} ${pct(d.worst.appointment.rate)}`);
    }
  }
  if (!report.impact.some((d) => d.best)) lines.push(`- Noch zu wenig Daten (Quoten erst ab ${report.minN} erreichten Leads pro Gruppe).`);
  lines.push('');
  lines.push('SCORE-CHECK');
  for (const g of report.scoreCheck.rows) lines.push(`- Grade ${g.label}: ${rateText(g.appointment)}`);
  lines.push(
    report.scoreCheck.separates == null
      ? '- Trennt der Score? Noch zu wenig Daten.'
      : report.scoreCheck.separates
        ? '- Der Score trennt: bessere Grades bringen klar mehr Termine.'
        : '- Der Score trennt noch nicht klar.',
  );
  lines.push('', `Erstellt am ${formatZurich(report.generatedAt)} · Details im Dashboard des Sales-Portals.`);
  return { subject: `Wochenreport Sales-Portal – ${report.period.label}`, body: lines.join('\n') };
}

/** Previous calendar week (Mon–Sun) relative to `now`. */
export function previousWeekStart(now: Date): string {
  return addDaysIso(weekStartIso(now), -7);
}

/** Due from Monday 07:00 (Zurich) until it was sent for the previous week (catches up if the server was down). */
export function isWeeklyReportDue(now: Date, lastSentWeek: string | null): boolean {
  const monday = weekStartIso(now);
  if (now.getTime() < zurichTime(monday, WEEKLY_REPORT_HOUR).getTime()) return false;
  return lastSentWeek !== previousWeekStart(now);
}

export async function lastSentWeek(db: Db): Promise<string | null> {
  const [row] = await db.select({ value: syncState.value }).from(syncState).where(eq(syncState.key, WEEKLY_REPORT_STATE_KEY));
  const v = row?.value as { lastWeek?: string } | undefined;
  return v?.lastWeek ?? null;
}

export async function previewWeeklyReport(db: Db, adapters: Adapters, now: Date): Promise<WeeklyReportPreview> {
  const report = await buildReport(db, adapters, { range: 'week', anchor: previousWeekStart(now), now });
  const { subject, body } = weeklyReportText(report);
  return { recipient: await getExtraSetting(db, 'weeklyReport.recipient'), subject, body, lastSentWeek: await lastSentWeek(db) };
}

export type SendResult = { status: 'sent'; recipient: string; week: string } | { status: 'skipped'; reason: 'no_recipient' | 'already_sent' };

/**
 * Send the report for the previous week. `force` sends even if already sent (admin «Jetzt senden»).
 * Idempotent for the job: the week is stored in sync_state after sending.
 */
export async function sendWeeklyReport(
  db: Db,
  adapters: Adapters,
  now: Date,
  options: { force?: boolean; actor?: { userId: string; displayName: string } } = {},
): Promise<SendResult> {
  const recipient = await getExtraSetting(db, 'weeklyReport.recipient');
  if (!recipient) return { status: 'skipped', reason: 'no_recipient' };
  const week = previousWeekStart(now);
  if (!options.force && (await lastSentWeek(db)) === week) return { status: 'skipped', reason: 'already_sent' };
  const report = await buildReport(db, adapters, { range: 'week', anchor: week, now });
  const { subject, body } = weeklyReportText(report);
  const sender = (await getExtraSetting(db, 'weeklyReport.sender')) ?? recipient;
  const sent = await adapters.mail.send({ userId: options.actor?.userId ?? null, email: sender, displayName: 'Sales-Portal' }, { to: [recipient], subject, body });
  await db
    .insert(syncState)
    .values({ key: WEEKLY_REPORT_STATE_KEY, value: { lastWeek: week, sentAt: sent.sentAt }, updatedAt: now })
    .onConflictDoUpdate({ target: syncState.key, set: { value: { lastWeek: week, sentAt: sent.sentAt }, updatedAt: now } });
  await audit(db, {
    actor: options.actor ?? 'system',
    action: 'dashboard.weekly_report_sent',
    entity: 'weekly_report',
    entityId: week,
    meta: { mailId: sent.id, redirected: sent.redirected, forced: !!options.force },
  });
  return { status: 'sent', recipient, week };
}
