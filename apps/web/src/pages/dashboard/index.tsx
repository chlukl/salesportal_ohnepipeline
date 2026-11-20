/**
 * Dashboard (INTENT 6.12) – Rollen Sales, AI-Spezialist, Admin; nie Coldcaller (Server erzwingt, auch bei «Ansicht als»).
 * Aktivität · Ergebnis · Wo es wirkt · Termine · Score-Check, Zeitraum Woche/Monat/Quartal, Vorschau Wochenreport.
 */
import { RESULT_GROUP_LABELS, type DashboardDimension, type DashboardRange, type DashboardReport, type ResultGroupKey, type WeeklyReportPreview } from '@sales-portal/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BarChart3, CalendarRange, ChevronLeft, ChevronRight, Mail, RefreshCw, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { api, errorMessage } from '@/app/api';
import { useAuth } from '@/app/auth';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, IconButton, PageHeader, Skeleton, Table, Tabs, TBody, TD, TH, THead, TR } from '@/components/ui';
import './dashboard.css';
import { BreakdownTable, chartTooltipStyle, fmtNum, fmtPct, Heatmap, RateTileValue, SectionTitle, StatTile, ciText } from './parts';

const RANGES: { id: DashboardRange; label: string }[] = [
  { id: 'week', label: 'Woche' },
  { id: 'month', label: 'Monat' },
  { id: 'quarter', label: 'Quartal' },
];

type Outcome = 'Termin' | 'Absage' | 'Offen' | 'Nicht erreicht';
const OUTCOMES: { key: Outcome; color: string }[] = [
  { key: 'Termin', color: 'var(--series-1)' },
  { key: 'Absage', color: 'var(--series-2)' },
  { key: 'Offen', color: 'var(--series-3)' },
  { key: 'Nicht erreicht', color: 'var(--series-4)' },
];
const OUTCOME_OF: Record<ResultGroupKey, Outcome> = {
  meeting_booked: 'Termin',
  proposals_sent: 'Termin',
  no_need: 'Absage',
  has_partner: 'Absage',
  internal_group: 'Absage',
  too_small: 'Absage',
  do_not_contact: 'Absage',
  competitor: 'Absage',
  not_reached: 'Nicht erreicht',
  wrong_number: 'Nicht erreicht',
  callback: 'Offen',
  waiting: 'Offen',
  info_mail: 'Offen',
  later: 'Offen',
  wrong_person: 'Offen',
};

const axisProps = { stroke: 'var(--viz-axis)', tick: { fontSize: 11, fill: 'var(--kls-fg-subtle)' }, tickLine: false, axisLine: false } as const;

function dayLabel(iso: string, range: DashboardRange): string {
  const [, m, d] = iso.split('-');
  if (range === 'week') {
    const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(`${iso}T12:00:00Z`).getUTCDay()];
    return `${wd} ${d}.${m}.`;
  }
  return `${d}.${m}.`;
}

export default function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const range = (RANGES.some((r) => r.id === params.get('range')) ? params.get('range') : 'week') as DashboardRange;
  const anchor = params.get('anchor') ?? undefined;
  const [reportOpen, setReportOpen] = useState(false);

  const setPeriod = (next: { range?: DashboardRange; anchor?: string | null }) => {
    const p = new URLSearchParams(params);
    if (next.range) p.set('range', next.range);
    if (next.anchor === null) p.delete('anchor');
    else if (next.anchor) p.set('anchor', next.anchor);
    setParams(p, { replace: true });
  };

  const report = useQuery({
    queryKey: ['dashboard', 'report', range, anchor ?? 'today'],
    queryFn: ({ signal }) => api.get<DashboardReport>('/api/dashboard/report', { range, anchor }, signal),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });
  const data = report.data;

  useShortcut('w', () => setPeriod({ range: 'week' }), { description: 'Zeitraum Woche', group: 'Dashboard' });
  useShortcut('m', () => setPeriod({ range: 'month' }), { description: 'Zeitraum Monat', group: 'Dashboard' });
  useShortcut('q', () => setPeriod({ range: 'quarter' }), { description: 'Zeitraum Quartal', group: 'Dashboard' });
  useShortcut('arrowleft', () => data && setPeriod({ anchor: data.period.prevAnchor }), { description: 'Vorheriger Zeitraum', group: 'Dashboard' });
  useShortcut('arrowright', () => data?.period.nextAnchor && setPeriod({ anchor: data.period.nextAnchor }), { description: 'Nächster Zeitraum', group: 'Dashboard' });
  useShortcut('t', () => setPeriod({ anchor: null }), { description: 'Zum aktuellen Zeitraum', group: 'Dashboard' });
  useShortcut('r', () => setReportOpen(true), { description: 'Vorschau Wochenreport', group: 'Dashboard' });

  return (
    <div className="viz-root">
      <PageHeader
        title="Dashboard"
        description="Wo Termine entstehen – und wo Absagen."
        actions={
          <Button variant="primary" icon={Mail} kbd="R" onClick={() => setReportOpen(true)}>
            Vorschau Wochenreport
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Tabs variant="pill" items={RANGES} value={range} onChange={(id) => setPeriod({ range: id })} label="Zeitraum" />
        <div className="flex items-center gap-1">
          <IconButton icon={ChevronLeft} label="Vorheriger Zeitraum (←)" disabled={!data} onClick={() => data && setPeriod({ anchor: data.period.prevAnchor })} />
          <span className="flex min-w-56 items-center justify-center gap-2 text-sm font-medium text-fg">
            <CalendarRange className="size-4 text-fg-subtle" aria-hidden />
            {data ? data.period.label : <Skeleton className="h-4 w-40" />}
          </span>
          <IconButton icon={ChevronRight} label="Nächster Zeitraum (→)" disabled={!data?.period.nextAnchor} onClick={() => data?.period.nextAnchor && setPeriod({ anchor: data.period.nextAnchor })} />
        </div>
        {anchor && (
          <Button variant="ghost" size="sm" onClick={() => setPeriod({ anchor: null })}>
            Aktueller Zeitraum
          </Button>
        )}
        {report.isFetching && data && <span className="text-xs text-fg-subtle">aktualisiert …</span>}
      </div>

      {report.isError ? (
        <Card>
          <EmptyState
            icon={RefreshCw}
            title="Kennzahlen konnten nicht geladen werden"
            description={errorMessage(report.error)}
            action={<Button onClick={() => void report.refetch()}>Nochmals versuchen</Button>}
          />
        </Card>
      ) : !data ? (
        <DashboardSkeleton />
      ) : data.activity.calls === 0 ? (
        <Card>
          <EmptyState
            icon={BarChart3}
            title="In diesem Zeitraum gibt es noch keine Anrufe"
            description="Sobald Anrufe mit Ergebnis gespeichert sind, erscheinen hier die Zahlen. Wähle einen früheren Zeitraum oder einen längeren (Monat, Quartal)."
            action={
              <Button onClick={() => setPeriod({ anchor: data.period.prevAnchor })} icon={ChevronLeft}>
                Vorheriger Zeitraum
              </Button>
            }
          />
        </Card>
      ) : (
        <Content data={data} range={range} />
      )}

      <WeeklyReportDialog open={reportOpen} onClose={() => setReportOpen(false)} />
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div aria-busy="true" className="space-y-6">
      <div className="grid grid-cols-5 gap-4">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
      <Skeleton className="h-80" />
    </div>
  );
}

function Content({ data, range }: { data: DashboardReport; range: DashboardRange }) {
  const a = data.activity;
  const r = data.results;
  const activityData = range === 'quarter' ? a.weeks.map((w) => ({ label: w.label, Anrufe: w.calls, Gespräche: w.conversations })) : a.days.map((d) => ({ label: dayLabel(d.date, range), Anrufe: d.calls, Gespräche: d.conversations }));
  const resultData = r.weeks.map((w) => {
    const row: Record<string, number | string> = { label: w.label };
    for (const o of OUTCOMES) row[o.key] = 0;
    for (const [k, v] of Object.entries(w.counts) as [ResultGroupKey, number][]) row[OUTCOME_OF[k]] = (row[OUTCOME_OF[k]] as number) + v;
    return row;
  });
  const maxReason = Math.max(1, ...r.reasons.map((x) => x.count));

  return (
    <>
      <div className="grid grid-cols-5 gap-4">
        <StatTile label="Anrufe" value={fmtNum(a.calls)} sub={`${fmtNum(a.reached)} erreicht (${fmtPct(a.calls ? a.reached / a.calls : null)})`} />
        <StatTile label="Gespräche ab 4 Min." value={fmtNum(a.conversations)} sub={a.calls ? `${fmtPct(a.conversations / a.calls)} der Anrufe` : undefined} />
        <StatTile label="Erreichte Leads" value={fmtNum(r.leadsReached)} sub="Basis für die Quoten" hint="Jeder Lead zählt einmal: ein Termin zählt immer, sonst das letzte Ergebnis im Zeitraum." />
        <StatTile label="Terminquote" value={<RateTileValue rate={r.appointment} />} sub={r.appointment.rate != null ? ciText(r.appointment) : `ab ${data.minN} erreichten Leads`} hint="Termin gebucht oder 3 Vorschläge gesendet, je erreichtem Lead." />
        <StatTile label="Absagequote" value={<RateTileValue rate={r.rejection} />} sub={r.rejection.rate != null ? ciText(r.rejection) : `ab ${data.minN} erreichten Leads`} hint="Kein Bedarf, Hat Partner, Intern/Konzern, Zu klein, Nicht mehr kontaktieren, Mitbewerber." />
      </div>

      <SectionTitle title="Aktivität" description="Wie viel telefoniert wurde und wann Leute erreichbar sind." />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={range === 'quarter' ? 'Anrufe pro Woche' : 'Anrufe pro Tag'} description="Alle ausgehenden Anrufe und Gespräche ab 4 Minuten" />
          <CardBody>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={activityData} barGap={2} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
                  <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} {...axisProps} />
                  <ChartTooltip contentStyle={chartTooltipStyle} cursor={{ fill: 'var(--kls-surface-2)' }} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: 'var(--kls-fg-muted)' }} />
                  <Bar dataKey="Anrufe" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={28} />
                  <Bar dataKey="Gespräche" name="Gespräche ab 4 Min." fill="var(--series-3)" radius={[4, 4, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Erreichbarkeit nach Stunde und Wochentag" description="Je dunkler, desto mehr Anrufe wurden angenommen" />
          <CardBody>
            <Heatmap cells={a.heatmap} />
          </CardBody>
        </Card>
      </div>

      <SectionTitle title="Ergebnis" description="Was bei den Anrufen herauskommt – pro Woche und warum abgesagt wird." />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Ergebnisse pro Woche" description="Anrufe mit Ergebnis, zusammengefasst" />
          <CardBody>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={resultData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
                  <XAxis dataKey="label" {...axisProps} />
                  <YAxis allowDecimals={false} {...axisProps} />
                  <ChartTooltip contentStyle={chartTooltipStyle} cursor={{ fill: 'var(--kls-surface-2)' }} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: 'var(--kls-fg-muted)' }} />
                  {OUTCOMES.map((o, i) => (
                    <Bar key={o.key} dataKey={o.key} stackId="r" fill={o.color} stroke="var(--kls-surface)" strokeWidth={1} radius={i === OUTCOMES.length - 1 ? [4, 4, 0, 0] : undefined} maxBarSize={44} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-fg-muted hover:text-fg">Alle Ergebnisgruppen als Tabelle</summary>
              <Table dense className="mt-2">
                <THead>
                  <tr>
                    <TH>Ergebnisgruppe</TH>
                    <TH>zählt als</TH>
                    <TH align="right">Anrufe</TH>
                  </tr>
                </THead>
                <TBody>
                  {r.totals.map((x) => (
                    <TR key={x.key}>
                      <TD>{RESULT_GROUP_LABELS[x.key]}</TD>
                      <TD className="text-fg-muted">{OUTCOME_OF[x.key]}</TD>
                      <TD align="right">{fmtNum(x.count)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </details>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Gründe der Absagen" description="Anrufe nach Absagegrund" />
          <CardBody>
            {r.reasons.length === 0 ? (
              <p className="py-8 text-center text-sm text-fg-subtle">Keine Absagen in diesem Zeitraum.</p>
            ) : (
              <ul className="space-y-3">
                {r.reasons.map((x) => (
                  <li key={x.key}>
                    <div className="mb-1 flex justify-between text-sm">
                      <span className="text-fg">{x.label}</span>
                      <span className="tabular text-fg-muted">{fmtNum(x.count)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-surface-2">
                      <div className="h-2 rounded-full" style={{ width: `${(x.count / maxReason) * 100}%`, backgroundColor: 'var(--series-2)' }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <Impact data={data} />
      <Meetings data={data} />
      <ScoreCheck data={data} />

      <p className="mt-8 text-xs text-fg-subtle">
        Quoten je erreichtem Lead (ein Termin zählt immer, sonst das letzte Ergebnis). Quoten erst ab {data.minN} erreichten Leads pro Gruppe, mit 95 %-Bereich (Wilson). Ältere Anrufe ohne Ergebnis zählen als erreicht, wenn sie mindestens 4 Minuten dauerten.
      </p>
    </>
  );
}

function Impact({ data }: { data: DashboardReport }) {
  const [dim, setDim] = useState<DashboardDimension>('industry');
  const current = data.impact.find((d) => d.dimension === dim) ?? data.impact[0];
  return (
    <>
      <SectionTitle title="Wo es wirkt" description="Termin- und Absagequote nach Merkmalen der Leads. Der Strich zeigt, wie sicher die Quote ist." />
      <Card>
        <div className="px-5 pt-4">
          <Tabs items={data.impact.map((d) => ({ id: d.dimension, label: d.label }))} value={current.dimension} onChange={setDim} label="Merkmal" />
        </div>
        <div className="px-5 py-3 text-sm text-fg-muted">
          {current.best && current.worst ? (
            <span>
              Am besten: <strong className="text-fg">{current.best.label}</strong> ({fmtPct(current.best.appointment.rate)}) · am schwächsten:{' '}
              <strong className="text-fg">{current.worst.label}</strong> ({fmtPct(current.worst.appointment.rate)})
            </span>
          ) : (
            <span>Für einen Vergleich braucht es mindestens zwei Gruppen mit je {data.minN} erreichten Leads.</span>
          )}
        </div>
        {current.rows.length === 0 ? (
          <EmptyState compact title="Noch keine erreichten Leads" description="Sobald Anrufe mit Ergebnis gespeichert sind, erscheinen hier die Gruppen." />
        ) : (
          <BreakdownTable rows={current.rows} minN={data.minN} best={current.best?.key} worst={current.worst?.key} />
        )}
      </Card>
    </>
  );
}

function Meetings({ data }: { data: DashboardReport }) {
  const m = data.meetings;
  return (
    <>
      <SectionTitle title="Termine" description="Gebuchte Erstgespräche, Absagen und freie Kapazität." />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Gebuchte Erstgespräche"
            description={m.extraCallShare != null ? `Davon Zusatzcalls: ${m.extraCalls} (${fmtPct(m.extraCallShare)})` : 'im gewählten Zeitraum'}
            actions={
              <div className="flex gap-2">
                <Badge tone={m.cancelled ? 'warning' : 'neutral'}>{m.cancelled} abgesagt</Badge>
                <Badge>{m.rescheduled} verschoben</Badge>
              </div>
            }
          />
          {m.bySales.length === 0 ? (
            <EmptyState compact title="Keine Termine gebucht" description="In diesem Zeitraum wurde kein Erstgespräch gebucht." />
          ) : (
            <Table dense>
              <THead>
                <tr>
                  <TH>Sales</TH>
                  <TH align="right">gebucht</TH>
                  <TH align="right">davon Zusatzcalls</TH>
                </tr>
              </THead>
              <TBody>
                {m.bySales.map((s) => (
                  <TR key={s.userId ?? s.name}>
                    <TD className="font-medium">{s.name}</TD>
                    <TD align="right">{fmtNum(s.booked)}</TD>
                    <TD align="right">{fmtNum(s.extraCalls)}</TD>
                  </TR>
                ))}
                <TR>
                  <TD className="font-medium text-fg-muted">Total</TD>
                  <TD align="right" className="font-semibold">
                    {fmtNum(m.total)}
                  </TD>
                  <TD align="right">{fmtNum(m.extraCalls)}</TD>
                </TR>
              </TBody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title={`Freie Kapazität ${m.capacityNames.sales} + ${m.capacityNames.specialist}`} description="Mögliche Startzeiten mit Puffer, aktuelle und nächste 3 Wochen" />
          {m.capacity ? (
            <Table dense>
              <THead>
                <tr>
                  <TH>Woche</TH>
                  <TH align="right">beide frei</TH>
                  <TH align="right">{m.capacityNames.sales}</TH>
                  <TH align="right">{m.capacityNames.specialist}</TH>
                </tr>
              </THead>
              <TBody>
                {m.capacity.map((w) => (
                  <TR key={w.week}>
                    <TD className="font-medium">{w.label}</TD>
                    <TD align="right" className="font-semibold">
                      {fmtNum(w.joint)}
                    </TD>
                    <TD align="right">{fmtNum(w.sales)}</TD>
                    <TD align="right">{fmtNum(w.specialist)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <EmptyState compact title="Kapazität nicht verfügbar" description={m.capacityError ?? 'Kalender nicht erreichbar.'} />
          )}
        </Card>
      </div>
    </>
  );
}

function ScoreCheck({ data }: { data: DashboardReport }) {
  const s = data.scoreCheck;
  const verdict =
    s.separates == null
      ? { tone: 'neutral' as const, text: `Noch zu wenig Daten – es braucht mindestens zwei Grades mit je ${data.minN} erreichten Leads.` }
      : s.separates
        ? { tone: 'success' as const, text: 'Der Score trennt: bessere Grades bringen klar mehr Termine.' }
        : s.monotonic
          ? { tone: 'warning' as const, text: 'Die Richtung stimmt, der Unterschied ist aber noch nicht sicher.' }
          : { tone: 'warning' as const, text: 'Der Score trennt noch nicht: ein schlechterer Grade hat eine höhere Terminquote.' };
  return (
    <>
      <SectionTitle title="Score-Check" description="Terminquote je Grade – trennt der Lead-Score gute von schlechten Leads?" />
      <Card>
        <div className="flex items-center gap-2 px-5 py-4 text-sm">
          <Badge tone={verdict.tone} dot>
            {s.separates == null ? 'offen' : s.separates ? 'trennt' : 'trennt nicht klar'}
          </Badge>
          <span className="text-fg-muted">{verdict.text}</span>
        </div>
        <BreakdownTable rows={s.rows} minN={data.minN} />
      </Card>
    </>
  );
}

function WeeklyReportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me, hasRole } = useAuth();
  const canSend = me.isRealAdmin && hasRole('admin');
  const preview = useQuery({
    queryKey: ['dashboard', 'weekly-report'],
    queryFn: () => api.get<WeeklyReportPreview>('/api/dashboard/weekly-report/preview'),
    enabled: open,
  });
  const send = useMutation({
    mutationFn: () => api.post<{ status: 'sent' | 'skipped'; recipient?: string; reason?: string }>('/api/dashboard/weekly-report/send'),
    onSuccess: (res) => {
      if (res.status === 'sent') toast.success('Wochenreport gesendet', { description: `an ${res.recipient}` });
      else toast.warning('Nicht gesendet', { description: 'Im Admin unter «Einstellungen» zuerst eine Empfänger-Adresse eintragen.' });
      void preview.refetch();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const p = preview.data;
  const body = useMemo(() => p?.body ?? '', [p]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Vorschau Wochenreport"
      description="Geht jeden Montagmorgen für die Vorwoche an die eingestellte Adresse – aus denselben Zahlen wie dieses Dashboard."
      footer={
        <>
          <Button onClick={onClose}>Schliessen</Button>
          {canSend && (
            <Button variant="primary" icon={Send} loading={send.isPending} disabled={!p?.recipient} onClick={() => send.mutate()}>
              Jetzt senden
            </Button>
          )}
        </>
      }
    >
      {preview.isLoading || !p ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
            <dt className="text-fg-muted">An</dt>
            <dd className="text-fg">{p.recipient ?? <span className="text-warning">noch keine Adresse – im Admin unter «Einstellungen» eintragen</span>}</dd>
            <dt className="text-fg-muted">Betreff</dt>
            <dd className="text-fg">{p.subject}</dd>
            <dt className="text-fg-muted">Zuletzt gesendet</dt>
            <dd className="text-fg">{p.lastSentWeek ? `für die Woche ab ${p.lastSentWeek.split('-').reverse().join('.')}` : 'noch nie'}</dd>
          </dl>
          <pre className="max-h-[50vh] overflow-auto rounded-md border border-border bg-surface-2 p-4 font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{body}</pre>
        </div>
      )}
    </Dialog>
  );
}
