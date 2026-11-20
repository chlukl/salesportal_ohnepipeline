/** Building blocks of the dashboard: number formats, stat tiles, rate bars with confidence interval, heatmap, tables. */
import type { DashboardBreakdownRow, RateValue } from '@sales-portal/shared';
import { Info } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Badge, Card, cn, Table, TBody, TD, TH, THead, Tooltip, TR } from '@/components/ui';

const nf = new Intl.NumberFormat('de-CH');

export const fmtNum = (n: number | null | undefined) => (n == null ? '–' : nf.format(n));
export const fmtPct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)} %`);

export function ciText(r: RateValue): string {
  if (!r.ci) return '';
  return `95 %-Bereich ${fmtPct(r.ci.low)}–${fmtPct(r.ci.high)}`;
}

export function StatTile({ label, value, sub, hint }: { label: string; value: ReactNode; sub?: ReactNode; hint?: string }) {
  return (
    <Card className="px-5 py-4">
      <p className="flex items-center gap-1.5 text-[13px] text-fg-muted">
        {label}
        {hint && (
          <Tooltip content={hint}>
            <Info className="size-3.5 text-fg-subtle" aria-label={hint} />
          </Tooltip>
        )}
      </p>
      <p className="tabular mt-1 text-[28px] leading-tight font-semibold text-fg">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-fg-subtle">{sub}</p>}
    </Card>
  );
}

/** Rate tile value: «23 %» or «zu wenig Daten» below n. */
export function RateTileValue({ rate }: { rate: RateValue }) {
  if (rate.rate == null) return <span className="text-lg text-fg-subtle">zu wenig Daten</span>;
  return <>{fmtPct(rate.rate)}</>;
}

export function TooFew({ n, minN }: { n: number; minN: number }) {
  return (
    <span className="text-xs text-fg-subtle" title={`Quoten erst ab ${minN} erreichten Leads`}>
      zu wenig Daten (n = {n})
    </span>
  );
}

/** Horizontal rate bar (0–100 %) with the Wilson interval as a whisker. */
export function RateBar({ rate, color, minN, scaleMax = 1 }: { rate: RateValue; color: string; minN: number; scaleMax?: number }) {
  if (rate.rate == null) return <TooFew n={rate.n} minN={minN} />;
  const pos = (v: number) => `${Math.min(100, (v / scaleMax) * 100)}%`;
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-2.5 w-40 shrink-0 rounded-full bg-surface-2" role="img" aria-label={`${fmtPct(rate.rate)}, ${ciText(rate)}`}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: pos(rate.rate), backgroundColor: color }} />
        {rate.ci && (
          <div
            className="absolute top-1/2 h-px -translate-y-1/2 bg-fg-muted"
            style={{ left: pos(rate.ci.low), width: `calc(${pos(rate.ci.high)} - ${pos(rate.ci.low)})` } as CSSProperties}
          >
            <span className="absolute -top-1 left-0 h-2 w-px bg-fg-muted" />
            <span className="absolute -top-1 right-0 h-2 w-px bg-fg-muted" />
          </div>
        )}
      </div>
      <Tooltip content={`${rate.hits} von ${rate.n} · ${ciText(rate)}`}>
        <span className="tabular w-12 text-right text-sm font-medium text-fg">{fmtPct(rate.rate)}</span>
      </Tooltip>
    </div>
  );
}

export function BreakdownTable({ rows, minN, best, worst }: { rows: DashboardBreakdownRow[]; minN: number; best?: string | null; worst?: string | null }) {
  const scaleMax = Math.max(0.2, ...rows.flatMap((r) => [r.appointment.ci?.high ?? 0, r.rejection.ci?.high ?? 0]));
  return (
    <Table dense>
      <THead>
        <tr>
          <TH>Gruppe</TH>
          <TH align="right">erreicht (n)</TH>
          <TH>Terminquote</TH>
          <TH>Absagequote</TH>
        </tr>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.key}>
            <TD className={cn('font-medium', r.tooFew && 'text-fg-muted')}>
              <span className="flex items-center gap-2">
                {r.label}
                {best === r.key && <Badge tone="success">am besten</Badge>}
                {worst === r.key && <Badge tone="warning">am schwächsten</Badge>}
              </span>
            </TD>
            <TD align="right">{fmtNum(r.n)}</TD>
            <TD>
              <RateBar rate={r.appointment} color="var(--series-1)" minN={minN} scaleMax={scaleMax} />
            </TD>
            <TD>{r.tooFew ? <span className="text-xs text-fg-subtle">–</span> : <RateBar rate={r.rejection} color="var(--series-2)" minN={minN} scaleMax={scaleMax} />}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function HeatRow({ day, hours: hs, byKey: map }: { day: number; hours: number[]; byKey: Map<string, { calls: number; reached: number }> }) {
  return (
    <>
      <span className="pr-2 text-right text-xs leading-8 text-fg-muted">{WEEKDAYS[day - 1]}</span>
      {hs.map((h) => {
        const c = map.get(`${day}:${h}`);
        const share = c && c.calls ? c.reached / c.calls : 0;
        const label = c ? `${WEEKDAYS[day - 1]} ${h}–${h + 1} Uhr: ${c.calls} Anrufe, ${c.reached} erreicht (${fmtPct(share)})` : `${WEEKDAYS[day - 1]} ${h}–${h + 1} Uhr: keine Anrufe`;
        return (
          <span
            key={h}
            title={label}
            aria-label={label}
            className={cn('viz-heat-cell tabular flex h-8 items-center justify-center rounded-sm text-[11px]', share > 0.55 ? 'text-white' : 'text-fg-muted')}
            style={{ '--heat': c ? `${Math.round(15 + share * 85)}%` : '0%' } as CSSProperties}
          >
            {c ? c.calls : ''}
          </span>
        );
      })}
    </>
  );
}

/** Reachability heatmap hour × weekday: color = share reached (one hue, light → dark), number = calls. */
export function Heatmap({ cells }: { cells: { weekday: number; hour: number; calls: number; reached: number }[] }) {
  const hours = cells.length ? [Math.min(8, ...cells.map((c) => c.hour)), Math.max(17, ...cells.map((c) => c.hour))] : [8, 17];
  const hourList = Array.from({ length: hours[1] - hours[0] + 1 }, (_, i) => hours[0] + i);
  const days = cells.some((c) => c.weekday > 5) ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5];
  const byKey = new Map(cells.map((c) => [`${c.weekday}:${c.hour}`, c]));
  return (
    <div>
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: `2.5rem repeat(${hourList.length}, minmax(0, 1fr))` }}>
        <span />
        {hourList.map((h) => (
          <span key={h} className="tabular pb-1 text-center text-[11px] text-fg-subtle">
            {h}
          </span>
        ))}
        {days.map((d) => (
          <HeatRow key={d} day={d} hours={hourList} byKey={byKey} />
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-fg-subtle">
        <span>Anteil erreicht:</span>
        <span>0 %</span>
        {[10, 30, 50, 70, 90].map((p) => (
          <span key={p} className="viz-heat-cell inline-block h-3 w-6 rounded-sm" style={{ '--heat': `${p}%` } as CSSProperties} />
        ))}
        <span>100 %</span>
        <span className="ml-3">Zahl im Feld = Anrufe</span>
      </div>
    </div>
  );

}

export function SectionTitle({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mt-10 mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-[17px] font-semibold text-fg">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export const chartTooltipStyle: CSSProperties = {
  backgroundColor: 'var(--kls-surface)',
  border: '1px solid var(--kls-border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--kls-fg)',
  boxShadow: 'var(--kls-shadow-md)',
};
