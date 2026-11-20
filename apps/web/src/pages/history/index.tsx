/**
 * Anrufhistorie (INTENT 6.15): Wen habe ich wann angerufen – und wer ruft an bzw. hat angerufen?
 * URL: `?kategorie=callback_missed&tag=2026-11-18&ergebnis=845140001&suche=<Nummer/Name/Firma>&offen=1`.
 * Verpasste Rückrufe bleiben hervorgehoben, bis zurückgerufen oder als erledigt markiert.
 */
import {
  CALL_CATEGORY_LABELS,
  formatZurich,
  optionLabel,
  RESULT_GROUP_CODES,
  RESULT_GROUP_LABELS,
  zurichDate,
  type CallCategory,
  type HistoryResponse,
  type HistoryRow,
  type ResultGroupKey,
} from '@sales-portal/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleHelp, History, Info, Link2, PhoneIncoming, PhoneMissed, PhoneOutgoing, RotateCcw, Search, SearchX, X, type LucideIcon } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, errorMessage } from '@/app/api';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Badge, Button, Card, cn, EmptyState, IconButton, Input, MultiSelect, PageHeader, Skeleton, Tabs, Toggle, type BadgeTone } from '@/components/ui';
import { dayHeading, formatDuration } from '@/pages/pendenzen/format';
import { AssignLeadDialog } from './AssignLeadDialog';

const CATEGORIES: CallCategory[] = ['outbound', 'callback_answered', 'callback_missed', 'unknown_number'];
const CATEGORY_META: Record<CallCategory, { icon: LucideIcon; tone: BadgeTone }> = {
  outbound: { icon: PhoneOutgoing, tone: 'neutral' },
  callback_answered: { icon: PhoneIncoming, tone: 'success' },
  callback_missed: { icon: PhoneMissed, tone: 'warning' },
  unknown_number: { icon: CircleHelp, tone: 'neutral' },
};
const RESULT_OPTIONS = (Object.keys(RESULT_GROUP_CODES) as ResultGroupKey[]).map((k) => ({ value: String(RESULT_GROUP_CODES[k]), label: RESULT_GROUP_LABELS[k] }));

const HISTORY_KEY = ['history'] as const;

export default function HistoryPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const category = (CATEGORIES as string[]).includes(params.get('kategorie') ?? '') ? (params.get('kategorie') as CallCategory) : null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('tag') ?? '') ? params.get('tag')! : '';
  const results = (params.get('ergebnis') ?? '').split(',').filter((v) => /^\d+$/.test(v));
  const search = params.get('suche') ?? '';
  const onlyOpen = params.get('offen') === '1';
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const query = useQuery({
    queryKey: [...HISTORY_KEY, { category, day, results, search, onlyOpen }],
    queryFn: ({ signal }) =>
      api.get<HistoryResponse & { warnings: string[] }>(
        '/api/history',
        { categories: category ? [category] : undefined, day, resultCodes: results, search, onlyOpen: onlyOpen || undefined, limit: 500 },
        signal,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const data = query.data;
  const rows = data?.items ?? [];

  // ---- search (debounced into the URL; also filled from the header search) -----------------------------------------
  const [term, setTerm] = useState(search);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => setTerm(search), [search]);
  useEffect(() => {
    if (term === search) return;
    const id = window.setTimeout(() => update({ suche: term.trim() || null }), 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);

  // ---- actions ------------------------------------------------------------------------------------------------------
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected((s) => Math.min(s, Math.max(rows.length - 1, 0))), [rows.length]);
  const current = rows[selected] as HistoryRow | undefined;
  const [assignFor, setAssignFor] = useState<HistoryRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: HISTORY_KEY });
    void qc.invalidateQueries({ queryKey: ['me', 'counters'] });
  };
  const setHandled = async (row: HistoryRow, handled: boolean, withUndo = true) => {
    if (!row.sessionId) return;
    setBusy(row.id);
    try {
      await api.post(`/api/history/sessions/${row.sessionId}/handled`, { handled });
      if (withUndo) {
        toast.success(handled ? 'Rückruf als erledigt markiert' : 'Wieder offen', {
          description: [row.personName, row.companyName].filter(Boolean).join(' · ') || row.phoneDisplay || undefined,
          action: { label: 'Rückgängig', onClick: () => void setHandled(row, !handled, false) },
        });
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const openLead = (row: HistoryRow) => row.leadId && navigate(`/lead/${row.leadId}`);

  const group = 'Anrufhistorie';
  useShortcut('j', () => setSelected((s) => Math.min(s + 1, rows.length - 1)), { description: 'Nächster Anruf', group });
  useShortcut('k', () => setSelected((s) => Math.max(s - 1, 0)), { description: 'Vorheriger Anruf', group });
  useShortcut('o', () => current && openLead(current), { description: 'Lead öffnen / zurückrufen', group });
  useShortcut('e', () => current?.open && void setHandled(current, true), { description: 'Verpassten Rückruf als erledigt markieren', group });
  useShortcut('z', () => current?.assignable && setAssignFor(current), { description: 'Unbekannte Nummer zuordnen', group });
  useShortcut('f', () => searchRef.current?.focus(), { description: 'In der Historie suchen', group });
  useShortcut('m', () => update({ kategorie: category === 'callback_missed' ? null : 'callback_missed' }), { description: 'Nur verpasste Rückrufe', group });

  // ---- header -------------------------------------------------------------------------------------------------------
  const firstOpen = rows.find((r) => r.open && r.leadId);
  const openMissed = data?.openMissed ?? 0;
  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  const filtersActive = !!(category || day || results.length || search || onlyOpen);

  // Group rows by Zurich day.
  const groups = useMemo(() => {
    const out: { day: string; rows: { row: HistoryRow; index: number }[] }[] = [];
    rows.forEach((row, index) => {
      const d = zurichDate(row.at);
      const last = out.at(-1);
      if (last && last.day === d) last.rows.push({ row, index });
      else out.push({ day: d, rows: [{ row, index }] });
    });
    return out;
  }, [rows]);

  return (
    <>
      <PageHeader
        title="Anrufhistorie"
        description={
          openMissed > 0
            ? `${openMissed} verpasste${openMissed === 1 ? 'r' : ''} Rückruf${openMissed === 1 ? '' : 'e'} offen – bleibt markiert, bis du zurückrufst oder ihn erledigst.`
            : 'Wen du wann angerufen hast – und wer zurückruft.'
        }
        actions={
          firstOpen ? (
            <Button variant="primary" icon={PhoneOutgoing} onClick={() => openLead(firstOpen)}>
              {`Zurückrufen: ${firstOpen.companyName ?? firstOpen.personName ?? firstOpen.phoneDisplay ?? 'Lead'}`}
            </Button>
          ) : (
            <Button variant="primary" icon={PhoneOutgoing} onClick={() => navigate('/anrufliste')}>
              Weiter mit der Anrufliste
            </Button>
          )
        }
      />

      {data?.warnings.map((w) => (
        <div key={w} className="mb-4 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-4 py-2.5 text-sm text-warning">
          <Info className="size-4 shrink-0" aria-hidden />
          {w}
        </div>
      ))}

      <Tabs
        label="Kategorie"
        className="mb-4"
        value={category ?? 'all'}
        onChange={(id) => update({ kategorie: id === 'all' ? null : id })}
        items={[
          { id: 'all', label: 'Alle', count: total },
          ...CATEGORIES.map((c) => ({ id: c, label: CALL_CATEGORY_LABELS[c].replace(/^./, (s) => s.toUpperCase()), count: data?.counts[c] ?? 0 })),
        ]}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          ref={searchRef}
          icon={Search}
          placeholder="Name, Firma oder Nummer"
          aria-label="In der Anrufhistorie suchen"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          className="w-72"
          trailing={
            term ? (
              <button type="button" aria-label="Suche leeren" className="text-fg-subtle hover:text-fg" onClick={() => setTerm('')}>
                <X className="size-3.5" />
              </button>
            ) : undefined
          }
        />
        <Input type="date" aria-label="Tag" value={day} max={zurichDate(new Date())} onChange={(e) => update({ tag: e.target.value || null })} className="w-44" />
        <MultiSelect label="Ergebnis" options={RESULT_OPTIONS} value={results} onChange={(v) => update({ ergebnis: v.length ? v.join(',') : null })} searchable />
        <Toggle className="ml-2" checked={onlyOpen} onChange={(v) => update({ offen: v ? '1' : null })} label="Nur offene" />
        {filtersActive && (
          <Button variant="ghost" icon={X} className="ml-auto" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Zurücksetzen
          </Button>
        )}
      </div>

      <Card className="overflow-hidden">
        {query.isLoading ? (
          <div className="space-y-2 p-5" aria-busy="true" aria-label="Anrufe werden geladen">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={SearchX}
            title="Anrufhistorie konnte nicht geladen werden"
            description={errorMessage(query.error)}
            action={
              <Button variant="primary" onClick={() => void query.refetch()}>
                Nochmals versuchen
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          filtersActive ? (
            <EmptyState
              icon={SearchX}
              title={search ? `Keine Anrufe zu «${search}»` : 'Keine Anrufe für diesen Filter'}
              description={search ? 'Für einen Rückruf: Nummer oben im Suchfeld eingeben (Kürzel /) – das Portal sucht im ganzen CRM.' : 'Filter lockern oder zurücksetzen.'}
              action={
                <Button variant="primary" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  Filter zurücksetzen
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={History}
              title="Noch keine Anrufe"
              description="Sobald du aus der Anrufliste anrufst, erscheinen die Anrufe hier – neueste zuoberst."
              action={
                <Button variant="primary" icon={PhoneOutgoing} onClick={() => navigate('/anrufliste')}>
                  Zur Anrufliste
                </Button>
              }
            />
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className="border-b border-border text-xs text-fg-subtle">
                  <th scope="col" className="h-10 w-[72px] px-3 pl-5 font-medium">Zeit</th>
                  <th scope="col" className="px-3 font-medium">Art</th>
                  <th scope="col" className="px-3 font-medium">Person · Firma</th>
                  <th scope="col" className="px-3 font-medium">Nummer</th>
                  <th scope="col" className="px-3 font-medium">Ergebnis</th>
                  <th scope="col" className="px-3 font-medium">Notiz</th>
                  <th scope="col" className="px-3 text-right font-medium">Dauer</th>
                  <th scope="col" className="w-[210px] px-3 pr-5 text-right font-medium">
                    <span className="sr-only">Aktionen</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.day}>
                    <tr className="bg-surface-2/70">
                      <th colSpan={8} scope="colgroup" className="px-5 py-1.5 text-xs font-semibold text-fg-muted">
                        {dayHeading(g.rows[0].row.at)}
                      </th>
                    </tr>
                    {g.rows.map(({ row, index }) => (
                      <HistoryLine
                        key={row.id}
                        row={row}
                        selected={index === selected}
                        busy={busy === row.id}
                        onSelect={() => setSelected(index)}
                        onOpen={() => openLead(row)}
                        onHandled={(h) => void setHandled(row, h)}
                        onAssign={() => setAssignFor(row)}
                      />
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {data && data.total > rows.length && (
              <p className="border-t border-border px-5 py-3 text-center text-[13px] text-fg-muted">
                {rows.length} von {data.total} Anrufen – mit Tag oder Suche eingrenzen.
              </p>
            )}
          </div>
        )}
      </Card>

      <AssignLeadDialog phone={assignFor?.phoneE164 ?? null} phoneDisplay={assignFor?.phoneDisplay} onClose={() => setAssignFor(null)} />
    </>
  );
}

function HistoryLine({
  row,
  selected,
  busy,
  onSelect,
  onOpen,
  onHandled,
  onAssign,
}: {
  row: HistoryRow;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onHandled: (handled: boolean) => void;
  onAssign: () => void;
}) {
  const meta = CATEGORY_META[row.category];
  const Icon = meta.icon;
  const result = optionLabel('kls_anrufergebnis', row.resultCode);
  return (
    <tr
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={() => row.leadId && onOpen()}
      className={cn(
        'relative border-b border-border last:border-b-0',
        row.open ? 'bg-warning-subtle/60' : selected ? 'bg-primary-subtle/50' : 'hover:bg-surface-2/60',
        selected && row.open && 'outline-2 -outline-offset-2 outline-primary/40',
      )}
    >
      <td className={cn('tabular px-3 py-2.5 pl-5 align-top text-fg-muted', (selected || row.open) && 'border-l-[3px]', row.open ? 'border-l-warning' : selected && 'border-l-primary')}>
        {formatZurich(row.at, 'HH:mm')}
      </td>
      <td className="px-3 py-2.5 align-top">
        <Badge tone={row.open ? 'warning' : row.category === 'callback_missed' ? 'neutral' : meta.tone}>
          <Icon className="size-3" aria-hidden />
          {CALL_CATEGORY_LABELS[row.category]}
        </Badge>
        {row.category === 'callback_missed' && row.handled && <p className="mt-1 text-[11px] text-fg-subtle">erledigt</p>}
      </td>
      <td className="max-w-[280px] px-3 py-2.5 align-top">
        {row.personName || row.companyName ? (
          <>
            <p className="truncate font-medium text-fg">{row.personName ?? row.companyName}</p>
            {row.personName && row.companyName && <p className="truncate text-xs text-fg-muted">{row.companyName}</p>}
          </>
        ) : (
          <p className="text-fg-muted">nicht im CRM</p>
        )}
        {row.lastOutbound && (
          <p className="mt-0.5 truncate text-[11px] text-fg-subtle">
            zuletzt angerufen am {formatZurich(row.lastOutbound.at, 'dd.MM.')}
            {row.lastOutbound.resultCode ? ` · ${optionLabel('kls_anrufergebnis', row.lastOutbound.resultCode)}` : ''}
          </p>
        )}
      </td>
      <td className="tabular px-3 py-2.5 align-top whitespace-nowrap text-fg-muted">{row.phoneDisplay ?? '–'}</td>
      <td className="max-w-[200px] px-3 py-2.5 align-top">{result ? <span className="text-fg">{result}</span> : <span className="text-fg-subtle">–</span>}</td>
      <td className="max-w-[320px] px-3 py-2.5 align-top">
        <p className="truncate text-fg-muted" title={row.notePreview ?? undefined}>
          {row.notePreview ?? row.subject ?? ''}
        </p>
      </td>
      <td className="tabular px-3 py-2.5 text-right align-top text-fg-muted">{formatDuration(row.durationSec) ?? ''}</td>
      <td className="px-3 py-2 pr-5 align-top" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          {row.open && row.leadId && (
            <Button size="sm" variant="secondary" icon={PhoneOutgoing} onClick={onOpen}>
              Zurückrufen
            </Button>
          )}
          {row.open && <IconButton size="sm" icon={Check} label="Als erledigt markieren" disabled={busy} onClick={() => onHandled(true)} />}
          {row.category === 'callback_missed' && row.handled && row.sessionId && (
            <IconButton size="sm" icon={RotateCcw} label="Wieder öffnen" disabled={busy} onClick={() => onHandled(false)} />
          )}
          {row.assignable && (
            <Button size="sm" variant="secondary" icon={Link2} onClick={onAssign}>
              Zuordnen
            </Button>
          )}
          {row.assignable && row.sessionId && !row.handled && (
            <IconButton size="sm" icon={Check} label="Ignorieren (erledigt)" disabled={busy} onClick={() => onHandled(true)} />
          )}
          {!row.open && row.leadId && (
            <Button size="sm" variant="ghost" onClick={onOpen}>
              Lead öffnen
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
