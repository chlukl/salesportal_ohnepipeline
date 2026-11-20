/**
 * Pendenzen – Startseite für alle Rollen (INTENT 6.16): alles, was eine Person erledigen oder vorbereiten muss.
 * Coldcaller: unabgeschlossene Anrufe, fällige Rückrufe und Aufgaben zuoberst. Filter in der URL
 * (`?art=task&faellig=overdue,today&herkunft=campaign&firma=…&status=open&person=<id>`), speicherbar.
 */
import type { PendenzDue, PendenzEntry, PendenzFilter, PendenzKind, PendenzOrigin, PendenzPerson, PendenzenResponse } from '@sales-portal/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Eye, Info, PhoneOutgoing, Search, SearchX, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, errorMessage } from '@/app/api';
import { useAuth } from '@/app/auth';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Button, Card, cn, EmptyState, Input, Kbd, MultiSelect, PageHeader, Select, Skeleton, Tabs } from '@/components/ui';
import { AnalysisReviewList } from '@/pages/ai';
import { deferCommit, opensAnalysisReview, primaryAction, UNDO_WINDOW_MS } from './actions';
import { PendenzRow, RescheduleDialog, SavedFilters, stripEmpty, useSavedFilters, type RowHandlers } from './components';
import { formatDue } from './format';
import { DUE_LABELS, KIND_LABELS, KIND_ORDER, ORIGIN_LABELS } from './meta';

const DUES: PendenzDue[] = ['overdue', 'today', 'this_week', 'later', 'none'];
const ORIGINS: PendenzOrigin[] = ['coldcall', 'campaign', 'other'];
const STATUS_OPTIONS = [
  { value: 'open', label: 'Offen' },
  { value: 'done', label: 'Erledigt' },
  { value: 'all', label: 'Alle' },
];

const csv = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);

function readFilter(params: URLSearchParams): PendenzFilter {
  const status = params.get('status');
  return {
    kinds: csv(params.get('art')).filter((k): k is PendenzKind => (KIND_ORDER as string[]).includes(k)),
    due: csv(params.get('faellig')).filter((d): d is PendenzDue => (DUES as string[]).includes(d)),
    origins: csv(params.get('herkunft')).filter((o): o is PendenzOrigin => (ORIGINS as string[]).includes(o)),
    company: params.get('firma') ?? '',
    status: status === 'done' || status === 'all' ? status : 'open',
    userId: params.get('person') || undefined,
  };
}

function writeFilter(filter: PendenzFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (filter.kinds?.length) p.set('art', filter.kinds.join(','));
  if (filter.due?.length) p.set('faellig', filter.due.join(','));
  if (filter.origins?.length) p.set('herkunft', filter.origins.join(','));
  if (filter.company?.trim()) p.set('firma', filter.company.trim());
  if (filter.status && filter.status !== 'open') p.set('status', filter.status);
  if (filter.userId) p.set('person', filter.userId);
  return p;
}

const PENDENZEN_KEY = ['pendenzen'] as const;

export default function PendenzenPage() {
  const { me, hasRole } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => readFilter(params), [params]);
  const setFilter = (next: PendenzFilter) => setParams(writeFilter(next), { replace: true });
  const hasFilter = [...params.keys()].length > 0;
  const filtersActive = !!(filter.due?.length || filter.origins?.length || filter.company?.trim() || filter.status !== 'open');
  const anyFilter = filtersActive || (filter.kinds?.length ?? 0) > 0;
  /** Reset everything except the person; «Rückgängig» restores the previous filter. */
  const resetFilter = () => {
    const previous = filter;
    setFilter({ userId: filter.userId });
    toast.info('Filter zurückgesetzt', { action: { label: 'Rückgängig', onClick: () => setParams(writeFilter(previous), { replace: true }) } });
  };
  // «Analysen zur Freigabe» (INTENT 6.4/6.16): collected review with approve / dismiss right here, not lead by lead.
  const showAnalyses = filter.kinds?.length === 1 && filter.kinds[0] === 'analysis' && hasRole('coldcaller', 'admin');

  // ---- data ---------------------------------------------------------------------------------------------------------
  const query = useQuery({
    queryKey: [...PENDENZEN_KEY, stripEmpty(filter)],
    queryFn: ({ signal }) =>
      api.get<PendenzenResponse>(
        '/api/pendenzen',
        { kinds: filter.kinds, due: filter.due, origins: filter.origins, company: filter.company, status: filter.status, userId: filter.userId },
        signal,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const persons = useQuery({
    queryKey: [...PENDENZEN_KEY, 'persons'],
    queryFn: () => api.get<{ items: PendenzPerson[] }>('/api/pendenzen/persons'),
    enabled: me.isRealAdmin,
    staleTime: 5 * 60_000,
  });
  const saved = useSavedFilters();

  // Default saved filter when the page opens without filter in the URL.
  const appliedDefault = useRef(false);
  useEffect(() => {
    if (appliedDefault.current || !saved.data) return;
    appliedDefault.current = true;
    const def = saved.data.items.find((f) => f.isDefault);
    if (def && !hasFilter) setFilter(def.filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.data]);

  const data = query.data;
  // CRM tasks marked «erledigt» wait out the undo window before the CRM call – hidden here meanwhile.
  const [pendingDone, setPendingDone] = useState<ReadonlySet<string>>(() => new Set());
  const items = useMemo(() => (data?.items ?? []).filter((i) => !pendingDone.has(i.id)), [data, pendingDone]);
  const viewingOther = !!data && data.person.id !== me.user.id;
  const isColdcaller = data ? data.coldcallerFirst : hasRole('coldcaller');

  // ---- company filter (debounced into the URL) ----------------------------------------------------------------------
  const [company, setCompany] = useState(filter.company ?? '');
  const companyRef = useRef<HTMLInputElement>(null);
  useEffect(() => setCompany(filter.company ?? ''), [filter.company]);
  useEffect(() => {
    if ((filter.company ?? '') === company) return;
    const id = window.setTimeout(() => setFilter({ ...filter, company }), 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company]);

  // ---- selection + actions ------------------------------------------------------------------------------------------
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected((s) => Math.min(s, Math.max(items.length - 1, 0))), [items.length]);
  const current = items[selected] as PendenzEntry | undefined;
  const [busy, setBusy] = useState<string | null>(null);
  const [dateItem, setDateItem] = useState<PendenzEntry | null>(null);
  const userId = viewingOther ? data!.person.id : undefined;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: PENDENZEN_KEY });
    void qc.invalidateQueries({ queryKey: ['me', 'counters'] });
  };
  const run = async (item: PendenzEntry, fn: () => Promise<void>) => {
    setBusy(item.id);
    try {
      await fn();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const setState = (item: PendenzEntry, body: { done?: boolean; snoozedUntil?: string | null }) =>
    api.put('/api/pendenzen/state', { itemKey: item.id, ...body, ...(userId ? { userId } : {}) });

  const setPending = (id: string, on: boolean) =>
    setPendingDone((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** «Aufgabe erledigt» with «Rückgängig»: the CRM task is closed only after the undo window (the CRM cannot reopen it). */
  const completeTaskDeferred = (item: PendenzEntry) => {
    const body = userId ? { userId } : {};
    setPending(item.id, true);
    const pending = deferCommit(() => api.post(`/api/pendenzen/tasks/${item.ref.id}/complete`, body).then(() => undefined), UNDO_WINDOW_MS, {
      onCommitted: () => {
        setPending(item.id, false);
        refresh();
      },
      onFailed: (err) => {
        setPending(item.id, false);
        toast.error('Aufgabe konnte im CRM nicht abgeschlossen werden', { description: errorMessage(err) });
        refresh();
      },
    });
    toast.success('Aufgabe erledigt', {
      description: `${item.title} – wird in ${UNDO_WINDOW_MS / 1000} Sekunden im CRM abgeschlossen.`,
      duration: UNDO_WINDOW_MS,
      action: {
        label: 'Rückgängig',
        onClick: () => {
          if (pending.cancel()) {
            setPending(item.id, false);
            toast.info('Aufgabe bleibt offen');
          } else {
            toast.warning('Zu spät – die Aufgabe ist im CRM schon abgeschlossen', { description: 'Bei Bedarf im CRM wieder öffnen oder neu anlegen.' });
          }
        },
      },
    });
  };

  const showAnalysisView = () => setFilter({ ...filter, kinds: ['analysis'] });

  const handlers: RowHandlers = {
    onOpen: (item) => (opensAnalysisReview(item) ? showAnalysisView() : item.link && navigate(item.link)),
    onOpenBriefing: (item) => item.leadId && navigate(`/lead/${item.leadId}?briefing=${item.ref.id}`),
    onDone: (item) => {
      if (item.actions.includes('complete')) return completeTaskDeferred(item);
      void run(item, async () => {
        if (item.actions.includes('mark_done')) {
          await setState(item, { done: true });
          toast.success('Erledigt', {
            description: item.title,
            action: { label: 'Rückgängig', onClick: () => void setState(item, { done: false }).then(refresh).catch((e) => toast.error(errorMessage(e))) },
          });
        }
      });
    },
    onReschedule: (item, at) =>
      void run(item, async () => {
        const label = formatDue(at, 'later') ?? '';
        if (item.actions.includes('reschedule')) {
          const res = await api.post<{ previousDueAt: string | null }>(`/api/pendenzen/tasks/${item.ref.id}/reschedule`, { dueAt: at, ...(userId ? { userId } : {}) });
          const previous = res.previousDueAt;
          toast.success(`Verschoben auf ${label}`, {
            description: 'Fälligkeit im CRM angepasst.',
            action: previous
              ? {
                  label: 'Rückgängig',
                  onClick: () =>
                    void api
                      .post(`/api/pendenzen/tasks/${item.ref.id}/reschedule`, { dueAt: previous, ...(userId ? { userId } : {}) })
                      .then(refresh)
                      .catch((e) => toast.error(errorMessage(e))),
                }
              : undefined,
          });
        } else {
          await setState(item, { snoozedUntil: at });
          toast.success(`Wieder da am ${label}`, {
            action: { label: 'Rückgängig', onClick: () => void setState(item, { snoozedUntil: null }).then(refresh).catch((e) => toast.error(errorMessage(e))) },
          });
        }
      }),
    onPickDate: (item) => setDateItem(item),
  };

  // ---- keyboard -----------------------------------------------------------------------------------------------------
  // In the «Analysen» view the review list owns J/K/E/X (AnalysisReviewList); the list shortcuts pause meanwhile.
  const group = 'Pendenzen';
  const list = !showAnalyses;
  useShortcut('j', () => setSelected((s) => Math.min(s + 1, items.length - 1)), { description: 'Nächste Pendenz', group, enabled: list });
  useShortcut('k', () => setSelected((s) => Math.max(s - 1, 0)), { description: 'Vorherige Pendenz', group, enabled: list });
  useShortcut('o', () => current && handlers.onOpen(current), { description: 'Pendenz öffnen', group, enabled: list });
  useShortcut('b', () => current?.actions.includes('open_briefing') && handlers.onOpenBriefing(current), { description: 'Briefing öffnen', group, enabled: list });
  useShortcut(
    'e',
    () => current && current.status === 'open' && (current.actions.includes('complete') || current.actions.includes('mark_done')) && handlers.onDone(current),
    { description: 'Als erledigt markieren', group, enabled: list },
  );
  useShortcut('v', () => current && (current.actions.includes('reschedule') || current.actions.includes('snooze')) && setDateItem(current), {
    description: 'Verschieben …',
    group,
    enabled: list,
  });
  useShortcut('f', () => companyRef.current?.focus(), { description: 'Nach Firma filtern', group, enabled: list });
  // «R» (not «X»: on the workspace X means «Nicht erreicht», in the analyses «verwerfen») – with «Rückgängig».
  useShortcut('r', () => resetFilter(), { description: 'Filter zurücksetzen', group, enabled: anyFilter });

  // ---- header -------------------------------------------------------------------------------------------------------
  const firstName = me.user.displayName.split(' ')[0];
  const openCount = items.filter((i) => i.status === 'open').length;
  const overdue = data?.dueCounts.overdue ?? 0;
  const top = items.find((i) => i.status === 'open' && i.link);
  const title = viewingOther ? `Pendenzen von ${data!.person.displayName}` : `Guten Tag, ${firstName}`;
  const description = query.isLoading
    ? 'Pendenzen werden geladen …'
    : openCount === 0
      ? 'Nichts Dringendes offen.'
      : `${openCount} ${openCount === 1 ? 'Pendenz' : 'Pendenzen'} offen${overdue ? ` · ${overdue} überfällig` : ''}`;

  const totalCount = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  const tabKinds = KIND_ORDER.filter((k) => (data?.counts[k] ?? 0) > 0 || filter.kinds?.includes(k));
  const activeTab = filter.kinds?.length === 1 ? filter.kinds[0] : 'all';
  const topAction = top ? primaryAction(top) : null;
  const runTop = () => {
    if (!top || !topAction) return;
    if (topAction.kind === 'done') handlers.onDone(top);
    else handlers.onOpen(top);
  };

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={
          showAnalyses ? (
            // The analysis cards carry the primary action («Ergänzen»); the header only leads back.
            <Button variant="secondary" onClick={() => setFilter({ ...filter, kinds: [] })}>
              Alle Pendenzen
            </Button>
          ) : (
          <>
            {isColdcaller && top && (
              <Button variant="secondary" icon={PhoneOutgoing} onClick={() => navigate('/anrufliste')}>
                Anrufliste
              </Button>
            )}
            {top && topAction ? (
              <Button variant="primary" icon={topAction.kind === 'done' ? CheckCircle2 : undefined} iconRight={topAction.kind === 'done' ? undefined : ArrowRight} onClick={runTop}>
                {topAction.label}
              </Button>
            ) : (
              hasRole('coldcaller', 'admin') && (
                <Button variant="primary" icon={PhoneOutgoing} onClick={() => navigate('/anrufliste')}>
                  Weiter mit der Anrufliste
                </Button>
              )
            )}
          </>
          )
        }
      />

      {viewingOther && (
        <div className="mb-5 flex items-center justify-between gap-4 rounded-lg border border-info/30 bg-info-subtle px-4 py-2.5 text-sm text-info">
          <span className="flex items-center gap-2">
            <Eye className="size-4" aria-hidden />
            Du siehst die Pendenzen von <strong className="font-semibold">{data!.person.displayName}</strong>. Aktionen gelten für diese Person.
          </span>
          <Button size="sm" variant="secondary" onClick={() => setFilter({ ...filter, userId: undefined })}>
            Zurück zu meinen
          </Button>
        </div>
      )}

      {data?.warnings.map((w) => (
        <div key={w} className="mb-4 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-4 py-2.5 text-sm text-warning">
          <Info className="size-4 shrink-0" aria-hidden />
          {w}
        </div>
      ))}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px] min-[1600px]:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {/* Art */}
          <Tabs
            label="Art der Pendenz"
            className="mb-4 overflow-x-auto"
            value={activeTab}
            onChange={(id) => setFilter({ ...filter, kinds: id === 'all' ? [] : [id as PendenzKind] })}
            items={[{ id: 'all', label: 'Alle', count: totalCount }, ...tabKinds.map((k) => ({ id: k, label: KIND_LABELS[k], count: data?.counts[k] ?? 0 }))]}
          />

          {showAnalyses ? (
            <AnalysisReviewList userId={filter.userId} />
          ) : (
          <>
          {/* Filters */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Input
              ref={companyRef}
              icon={Search}
              placeholder="Firma oder Stichwort"
              aria-label="Nach Firma filtern"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className="w-64"
              trailing={
                company ? (
                  <button type="button" aria-label="Firma-Filter leeren" className="text-fg-subtle hover:text-fg" onClick={() => setCompany('')}>
                    <X className="size-3.5" />
                  </button>
                ) : undefined
              }
            />
            <MultiSelect
              label="Fälligkeit"
              options={DUES.map((d) => ({ value: d, label: DUE_LABELS[d] }))}
              value={filter.due ?? []}
              onChange={(due) => setFilter({ ...filter, due })}
            />
            <MultiSelect
              label="Herkunft"
              options={ORIGINS.map((o) => ({ value: o, label: ORIGIN_LABELS[o] }))}
              value={filter.origins ?? []}
              onChange={(origins) => setFilter({ ...filter, origins })}
            />
            <Select
              aria-label="Status"
              options={STATUS_OPTIONS}
              value={filter.status ?? 'open'}
              onChange={(e) => setFilter({ ...filter, status: e.target.value as PendenzFilter['status'] })}
              className="w-32"
            />
            {me.isRealAdmin && (
              <Select
                aria-label="Person"
                options={[
                  { value: '', label: 'Meine Pendenzen' },
                  ...(persons.data?.items ?? []).filter((p) => p.id !== me.user.id).map((p) => ({ value: p.id, label: p.displayName })),
                ]}
                value={filter.userId ?? ''}
                onChange={(e) => setFilter({ ...filter, userId: e.target.value || undefined })}
                className="w-48"
              />
            )}
            <div className="ml-auto flex items-center gap-2">
              {anyFilter && (
                <Button variant="ghost" size="md" icon={X} onClick={resetFilter} kbd="R">
                  Zurücksetzen
                </Button>
              )}
              <SavedFilters current={filter} onApply={setFilter} />
            </div>
          </div>

          <Card className="overflow-hidden">
            {query.isLoading ? (
              <ul aria-busy="true" aria-label="Pendenzen werden geladen">
                {Array.from({ length: 6 }, (_, i) => (
                  <li key={i} className="flex items-center gap-4 border-b border-border px-5 py-3.5 last:border-b-0">
                    <Skeleton className="size-9 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-1/3" />
                      <Skeleton className="h-3 w-2/3" />
                    </div>
                    <Skeleton className="h-3.5 w-24" />
                    <Skeleton className="h-8 w-40" />
                  </li>
                ))}
              </ul>
            ) : query.isError ? (
              <EmptyState
                icon={SearchX}
                title="Pendenzen konnten nicht geladen werden"
                description={errorMessage(query.error)}
                action={
                  <Button variant="primary" onClick={() => void query.refetch()}>
                    Nochmals versuchen
                  </Button>
                }
              />
            ) : items.length === 0 ? (
              anyFilter ? (
                <EmptyState
                  icon={SearchX}
                  title="Keine Pendenzen für diesen Filter"
                  description="Filter lockern oder zurücksetzen, um alles zu sehen."
                  action={
                    <Button variant="primary" onClick={resetFilter}>
                      Filter zurücksetzen
                    </Button>
                  }
                />
              ) : hasRole('coldcaller', 'admin') && !viewingOther ? (
                <EmptyState
                  icon={CheckCircle2}
                  title="Keine fälligen Pendenzen – weiter mit der Anrufliste"
                  description="Alles erledigt. Neue Rückrufe, Aufgaben und Analysen erscheinen hier automatisch."
                  action={
                    <Button variant="primary" icon={PhoneOutgoing} onClick={() => navigate('/anrufliste')}>
                      Zur Anrufliste
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={CheckCircle2}
                  title="Keine offenen Pendenzen"
                  description="Neue Termine, Briefings und Absagen erscheinen hier automatisch, sobald ein Erstgespräch gebucht wird."
                />
              )
            ) : (
              <ul aria-label="Pendenzen" className={cn(query.isFetching && !query.isLoading && 'opacity-80 transition-opacity')}>
                {items.map((item, i) => (
                  <PendenzRow
                    key={item.id}
                    item={item}
                    selected={i === selected}
                    busy={busy === item.id}
                    showOwner={viewingOther || (item.ownerUserId !== null && item.ownerUserId !== (data?.person.id ?? me.user.id) && item.kind === 'error')}
                    onSelect={() => setSelected(i)}
                    handlers={handlers}
                  />
                ))}
              </ul>
            )}
          </Card>
          </>
          )}
        </div>

        <Overview
          data={data}
          filter={filter}
          onFilter={setFilter}
          isColdcaller={isColdcaller}
          analyses={showAnalyses}
          onCallList={() => navigate('/anrufliste')}
        />
      </div>

      <RescheduleDialog
        item={dateItem}
        onClose={() => setDateItem(null)}
        onSave={(at) => {
          const item = dateItem;
          setDateItem(null);
          if (item) handlers.onReschedule(item, at);
        }}
      />
    </>
  );
}

function Overview({
  data,
  filter,
  onFilter,
  isColdcaller,
  analyses,
  onCallList,
}: {
  data: PendenzenResponse | undefined;
  filter: PendenzFilter;
  onFilter: (f: PendenzFilter) => void;
  isColdcaller: boolean;
  /** «Analysen» view: the keyboard card lists the review keys. */
  analyses: boolean;
  onCallList: () => void;
}) {
  const keys: [string, string][] = analyses
    ? [
        ['J / K', 'nächste / vorherige Analyse'],
        ['E', 'ergänzen (ins CRM)'],
        ['X', 'verwerfen'],
        ['R', 'zurück zu allen Pendenzen'],
      ]
    : [
        ['J / K', 'nächste / vorherige'],
        ['O', 'öffnen'],
        ['B', 'Briefing öffnen'],
        ['E', 'erledigt'],
        ['V', 'verschieben'],
        ['F', 'Firma filtern'],
        ['R', 'Filter zurücksetzen'],
      ];
  const toggleDue = (d: PendenzDue) => {
    const has = filter.due?.includes(d);
    onFilter({ ...filter, due: has ? (filter.due ?? []).filter((x) => x !== d) : [...(filter.due ?? []), d] });
  };
  const tones: Record<PendenzDue, string> = {
    overdue: 'text-warning',
    today: 'text-fg',
    this_week: 'text-fg',
    later: 'text-fg-muted',
    none: 'text-fg-muted',
  };
  return (
    <aside className="space-y-4" aria-label="Überblick">
      {analyses ? (
        <Card className="p-4">
          <h2 className="text-[13px] font-semibold text-fg">So geht's</h2>
          <p className="mt-1 text-[13px] text-fg-muted">
            Die KI schlägt nur vor. «Ergänzen» schreibt Zusammenfassung und Interesse in den Anruf im CRM – weitere Vorschläge nur, wenn du sie
            ankreuzst. Danach ist die nächste Analyse an der Reihe.
          </p>
        </Card>
      ) : (
      <Card className="p-4">
        <h2 className="mb-3 text-[13px] font-semibold text-fg">Fälligkeit</h2>
        <ul className="space-y-0.5">
          {(['overdue', 'today', 'this_week', 'later', 'none'] as PendenzDue[]).map((d) => {
            const active = filter.due?.includes(d);
            return (
              <li key={d}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleDue(d)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors',
                    active ? 'bg-primary-subtle text-primary' : 'hover:bg-surface-2',
                  )}
                >
                  <span className={cn(!active && tones[d])}>{DUE_LABELS[d]}</span>
                  <span className="tabular text-[13px] font-medium">{data ? data.dueCounts[d] : '–'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
      )}
      {isColdcaller && (
        <Card className="p-4">
          <h2 className="text-[13px] font-semibold text-fg">Danach</h2>
          <p className="mt-1 text-[13px] text-fg-muted">Wenn die fälligen Pendenzen erledigt sind, geht es mit deinem gespeicherten Filter in der Anrufliste weiter.</p>
          <Button className="mt-3 w-full" variant="secondary" icon={PhoneOutgoing} onClick={onCallList}>
            Zur Anrufliste
          </Button>
        </Card>
      )}
      <Card className="p-4">
        <h2 className="mb-2 text-[13px] font-semibold text-fg">Tastatur</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] text-fg-muted">
          {keys.map(([k, label]) => (
            <div key={k} className="contents">
              <dt className="font-medium text-fg">{k}</dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 flex items-center gap-1.5 border-t border-border pt-2.5 text-xs text-fg-subtle">
          Alle Kürzel: <Kbd>?</Kbd>
        </p>
      </Card>
    </aside>
  );
}
