/**
 * Anrufliste (INTENT 6.1, 6.13): filters, saved filters per person, free sorting, selectable columns, score badge +
 * first lines of the KI-Bewertung, hint for good call times, fast paging with prefetch. Calls start right here (dial
 * bar); «Verbunden» opens the Lead-Arbeitsplatz as overlay over the list (`CallOverlay`).
 * OWNER: coldcall implementer.
 */
import {
  CONTACT_ROLE_LABELS,
  EXCLUSION_LABELS,
  earliestNewAttempt,
  formatZurich,
  optionLabel,
  type Lead,
  type LeadSortKey,
  type Paged,
  type SavedFilter,
} from '@sales-portal/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, ChevronLeft, ChevronRight, Clock, Columns3, Phone, PhoneOff, Star, Trash2, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '@/app/api';
import { callView } from '@/app/callState';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  cn,
  Dialog,
  DropdownMenu,
  EmptyState,
  GradeBadge,
  IconButton,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  type MenuSection,
} from '@/components/ui';
import { DialBar, isRunning, notReachedToast, useLeadCall, useRestoreActiveCall, type NotReachedResponse } from '@/pages/calls';
import { lockReasons, type WorkspaceData, type WorkspaceEmbedding } from '@/pages/workspace';
import { CallOverlay, ConversationBar, minimizedCall } from './CallOverlay';
import { DailyGoal } from './DailyGoal';
import { FilterBar } from './Filters';
import { DEFAULT_FILTER, listSession, toParams, type ListFilter } from './listQuery';

const PAGE_SIZE = 50;

type ColumnKey = 'score' | 'company' | 'person' | 'employees' | 'place' | 'callstatus' | 'rating' | 'lastContact' | 'due' | 'phone' | 'owner' | 'assessment' | 'source';

interface ColumnDef {
  key: ColumnKey;
  label: string;
  sort?: LeadSortKey;
  align?: 'left' | 'right';
  className?: string;
  render: (lead: Lead, now: Date, ctx: CellContext) => React.ReactNode;
}

/** What a cell may do besides showing data – the phone number starts the call right in the list. */
interface CellContext {
  /** Start the call from the list; undefined when this lead cannot be called from here (locked, no number, call running). */
  onCall?: () => void;
  callHint: string;
}

function relDays(iso: string, now: Date): string {
  const days = Math.round((now.getTime() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'heute';
  if (days === 1) return 'gestern';
  if (days < 60) return `vor ${days} Tagen`;
  return `vor ${Math.round(days / 30)} Monaten`;
}

function dueLabel(iso: string, now: Date): { text: string; tone: 'danger' | 'warning' | 'neutral' } {
  const t = Date.parse(iso);
  const today = formatZurich(now, 'yyyy-MM-dd');
  const day = formatZurich(iso, 'yyyy-MM-dd');
  if (t < now.getTime() && day !== today) return { text: `überfällig seit ${formatZurich(iso, 'dd.MM.')}`, tone: 'danger' };
  if (day === today) return { text: `heute ${formatZurich(iso, 'HH:mm')}`, tone: 'warning' };
  return { text: formatZurich(iso, 'dd.MM. HH:mm'), tone: 'neutral' };
}

const COLUMNS: ColumnDef[] = [
  { key: 'score', label: 'Score', sort: 'score', render: (l) => <GradeBadge grade={l.grade} score={l.kls_leadscore} /> },
  {
    key: 'company',
    label: 'Firma',
    sort: 'companyname',
    className: 'min-w-[200px]',
    render: (l) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{l.companyname}</div>
        <div className="truncate text-xs text-fg-subtle">{[l.kls_industry ?? 'Branche fehlt', l.kls_custom_industry].filter(Boolean).join(' · ')}</div>
      </div>
    ),
  },
  {
    key: 'person',
    label: 'Ansprechperson',
    render: (l) => (
      <div className="min-w-0">
        <div className="truncate">
          {l.fullname ?? '–'}
          {l.decisionmaker && <span className="ml-1.5 text-[11px] text-success">Entscheider</span>}
        </div>
        <div className="truncate text-xs text-fg-subtle">{l.jobtitle ?? CONTACT_ROLE_LABELS[l.contactRole]}</div>
      </div>
    ),
  },
  // Telefon right after the person: Markus scans the list and clicks the number to call.
  {
    key: 'phone',
    label: 'Telefon',
    render: (l, _now, ctx) =>
      l.primaryPhone ? (
        ctx.onCall ? (
          // Markus scans the list and clicks the number: the call starts here, the list stays (no lead page).
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              ctx.onCall?.();
            }}
            title={`${l.primaryPhone.display} anrufen`}
            className="tabular -mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 whitespace-nowrap text-primary hover:bg-primary-subtle focus-visible:bg-primary-subtle"
          >
            <Phone className="size-3.5" aria-hidden />
            {l.primaryPhone.display}
          </button>
        ) : (
          <span className="tabular whitespace-nowrap text-fg-muted" title={ctx.callHint}>
            {l.primaryPhone.display}
          </span>
        )
      ) : (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-warning">
          <PhoneOff className="size-3.5" aria-hidden /> Nummer prüfen
        </span>
      ),
  },
  { key: 'employees', label: 'MA', sort: 'numberofemployees', align: 'right', render: (l) => (l.numberofemployees != null ? l.numberofemployees.toLocaleString('de-CH') : '–') },
  {
    key: 'place',
    label: 'Ort',
    sort: 'city',
    render: (l) => (
      <span className="whitespace-nowrap text-fg-muted">
        {l.address1_city ?? '–'} <span className="text-fg-subtle">{l.address1_stateorprovince}</span>
      </span>
    ),
  },
  {
    key: 'callstatus',
    label: 'Anrufstatus',
    render: (l, now) => {
      const pause = l.lastRealContact ? earliestNewAttempt(l.lastRealContact.resultCode, l.lastRealContact.at) : null;
      return (
        <div className="flex flex-wrap gap-1">
          {l.kls_callstatus ? <Badge>{optionLabel('kls_callstatus', l.kls_callstatus)}</Badge> : <span className="text-xs text-fg-subtle">noch nie angerufen</span>}
          {l.campaign.fromCampaign && <Badge tone="info">aus Kampagne</Badge>}
          {pause && Date.parse(pause) > now.getTime() && <Badge tone="warning">Kontaktpause bis {formatZurich(pause, 'dd.MM.yy')}</Badge>}
          {l.exclusions.length > 0 && (
            <Badge tone="danger" title={`Ausgeblendet: ${l.exclusions.map((e) => EXCLUSION_LABELS[e]).join(' · ')}`}>
              ausgeblendet
            </Badge>
          )}
        </div>
      );
    },
  },
  { key: 'rating', label: 'Bewertung', render: (l) => (l.kls_rating_category ? <span className="text-fg-muted">{optionLabel('kls_rating_category', l.kls_rating_category)}</span> : <span className="text-fg-subtle">–</span>) },
  {
    key: 'lastContact',
    label: 'Letzter Kontakt',
    sort: 'lastRealContact',
    render: (l, now) =>
      l.lastRealContact ? (
        <span className="whitespace-nowrap text-fg-muted" title={formatZurich(l.lastRealContact.at)}>
          {relDays(l.lastRealContact.at, now)}
        </span>
      ) : (
        <span className="text-fg-subtle">nie</span>
      ),
  },
  {
    key: 'due',
    label: 'Fällig',
    sort: 'nextDueAt',
    render: (l, now) => {
      if (l.nextDueAt) {
        const d = dueLabel(l.nextDueAt, now);
        return <Badge tone={d.tone === 'neutral' ? 'neutral' : d.tone}>{d.text}</Badge>;
      }
      if (l.nextAttemptAt) return <span className="text-xs text-fg-subtle">neuer Versuch ab {formatZurich(l.nextAttemptAt, 'dd.MM. HH:mm')}</span>;
      return <span className="text-fg-subtle">–</span>;
    },
  },
  { key: 'owner', label: 'Besitzer', render: (l) => <span className="text-fg-muted">{l.ownerName ?? '–'}</span> },
  {
    key: 'assessment',
    label: 'KI-Bewertung',
    className: 'min-w-[260px] max-w-[420px]',
    render: (l) =>
      l.assessment ? (
        <div className="text-xs leading-snug">
          {l.assessment.einstieg && <p className="line-clamp-2 text-fg-muted">{l.assessment.einstieg}</p>}
          {l.assessment.stichworte.length > 0 && <p className="mt-0.5 truncate text-fg-subtle">{l.assessment.stichworte.slice(0, 4).join(' · ')}</p>}
        </div>
      ) : (
        <span className="text-xs text-fg-subtle">noch keine Bewertung</span>
      ),
  },
  {
    key: 'source',
    label: 'Thema / Quelle',
    render: (l) => (
      <div className="text-xs">
        <div className="text-fg-muted">{l.subject ?? '–'}</div>
        <div className="text-fg-subtle">{optionLabel('leadsourcecode', l.leadsourcecode) ?? ''}</div>
      </div>
    ),
  },
];

const DEFAULT_COLUMNS: ColumnKey[] = ['score', 'company', 'person', 'phone', 'employees', 'place', 'callstatus', 'lastContact', 'due', 'assessment'];
const COLUMNS_KEY = 'sp.anrufliste.columns';

function loadColumns(): ColumnKey[] {
  try {
    const raw = localStorage.getItem(COLUMNS_KEY);
    const parsed = raw ? (JSON.parse(raw) as string[]) : null;
    const valid = parsed?.filter((k): k is ColumnKey => COLUMNS.some((c) => c.key === k));
    return valid?.length ? valid : DEFAULT_COLUMNS;
  } catch {
    return DEFAULT_COLUMNS;
  }
}

const SORT_OPTIONS: { value: LeadSortKey; label: string }[] = [
  { value: 'due_then_score', label: 'Fällig zuerst, dann Score' },
  { value: 'score', label: 'Score' },
  { value: 'lastRealContact', label: 'Letzter Kontakt' },
  { value: 'numberofemployees', label: 'Mitarbeitende' },
  { value: 'companyname', label: 'Firma A–Z' },
  { value: 'city', label: 'Ort' },
  { value: 'nextDueAt', label: 'Fälligkeit' },
  { value: 'modifiedon', label: 'Zuletzt geändert' },
];

/** Good call times from the Prod data (INTENT 2): 10 Uhr and 14–15 Uhr, Tuesday strongest; lunch almost nobody. */
function CallTimesHint() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const hour = Number(formatZurich(now, 'H'));
  const weekday = formatZurich(now, 'i'); // 1 = Monday
  const good = hour === 10 || hour === 14 || hour === 15;
  const lunch = hour === 12;
  return (
    <div className={cn('flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px]', good ? 'bg-success-subtle text-success' : 'bg-surface-2 text-fg-muted')}>
      <Clock className="size-4 shrink-0" aria-hidden />
      {good ? (
        <span>
          <strong className="font-semibold">Gute Anrufzeit</strong> – um diese Zeit entstehen die meisten Gespräche.
        </span>
      ) : lunch ? (
        <span>Über Mittag nimmt kaum jemand ab – gut für Nachbearbeitung und Pendenzen.</span>
      ) : (
        <span>Gute Anrufzeiten: 10 Uhr und 14–15 Uhr{weekday === '2' ? ' – heute ist Dienstag, der stärkste Tag.' : ', am stärksten am Dienstag.'}</span>
      )}
    </div>
  );
}

type SavedLeadFilter = SavedFilter<ListFilter> & { sort: { key: LeadSortKey; direction: 'asc' | 'desc' } | null };

function SaveFilterDialog({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (name: string, isDefault: boolean) => void }) {
  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  useEffect(() => {
    if (open) {
      setName('');
      setIsDefault(false);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Filter speichern"
      description="Filter, Sortierung und Spalten werden für dich gespeichert."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => onSave(name.trim(), isDefault)}>
            Speichern
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave(name.trim(), isDefault);
        }}
      >
        <Input label="Name" autoFocus maxLength={80} placeholder="z. B. A/B, 20–249 MA, ohne Bau" value={name} onChange={(e) => setName(e.target.value)} />
        <Checkbox label="Als Standard verwenden" description="Wird beim Öffnen der Anrufliste automatisch gewählt." checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
      </form>
    </Dialog>
  );
}

/** Callable right from the list (else «Anrufen» opens the Lead-Arbeitsplatz, which explains why not). */
function callableFromList(lead: Lead): boolean {
  return !!lead.primaryPhone && !lead.donotphone && lockReasons(lead).length === 0;
}

function callHint(lead: Lead): string {
  if (!lead.primaryPhone) return 'Keine Nummer – Lead öffnen und Nummer prüfen';
  if (lead.donotphone) return 'Möchte nicht angerufen werden';
  if (lockReasons(lead).length) return `Bitte nicht anrufen: ${lockReasons(lead).join(' · ')}`;
  return `${lead.fullname ?? lead.companyname} anrufen`;
}

export default function LeadsPage() {
  const activeCall = useRestoreActiveCall();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilterState] = useState<ListFilter>(() => listSession.filter());
  const [page, setPage] = useState(() => listSession.page());
  const [columns, setColumns] = useState<ColumnKey[]>(loadColumns);
  const [selected, setSelected] = useState(0);
  const [saveOpen, setSaveOpen] = useState(false);
  const [activeSaved, setActiveSaved] = useState<string | null>(null);
  // «überfällig», «heute fällig» … stay correct in a tab that is open all day.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const tableRef = useRef<HTMLDivElement>(null);
  // Arrow keys / Enter only while no button, menu or field has the focus (else they keep their own meaning).
  const [pageFocus, setPageFocus] = useState(true);
  useEffect(() => {
    const update = () => {
      const el = document.activeElement;
      setPageFocus(!el || el === document.body || !!tableRef.current?.contains(el));
    };
    const later = () => window.setTimeout(update, 0);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', later);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', later);
    };
  }, []);

  const setFilter = useCallback((next: ListFilter) => {
    setFilterState(next);
    setPage(1);
    setSelected(0);
    setActiveSaved(null);
  }, []);
  useEffect(() => listSession.setFilter(filter), [filter]);
  useEffect(() => listSession.setPage(page), [page]);
  useEffect(() => {
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns));
    } catch {
      /* ignore */
    }
  }, [columns]);

  const params = { ...toParams(filter), page, pageSize: PAGE_SIZE };
  const list = useQuery({
    queryKey: ['leads', 'list', params],
    queryFn: ({ signal }) => api.get<Paged<Lead>>('/api/leads', params, signal),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  // Prefetch the next page and the first lead's workspace («ohne spürbare Wartezeit»).
  useEffect(() => {
    if (!data) return;
    if (page < pages) {
      const nextParams = { ...params, page: page + 1 };
      void queryClient.prefetchQuery({ queryKey: ['leads', 'list', nextParams], queryFn: () => api.get<Paged<Lead>>('/api/leads', nextParams) });
    }
    const first = data.items[selected] ?? data.items[0];
    if (first) prefetchLead(first.leadid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, page, selected]);

  const prefetchLead = (leadId: string) =>
    void queryClient.prefetchQuery({ queryKey: ['workspace', leadId], queryFn: () => api.get(`/api/workspace/${leadId}`), staleTime: 60_000 });

  // Saved filters ---------------------------------------------------------------------------------------------------
  const saved = useQuery({ queryKey: ['leads', 'filters'], queryFn: () => api.get<{ items: SavedLeadFilter[] }>('/api/leads/filters') });
  const applySaved = useCallback(
    (f: SavedLeadFilter) => {
      setFilterState({ ...f.filter, sort: f.sort?.key ?? f.filter.sort, direction: f.sort?.direction ?? f.filter.direction });
      if (f.columns?.length) setColumns(f.columns.filter((k): k is ColumnKey => COLUMNS.some((c) => c.key === k)));
      setPage(1);
      setSelected(0);
      setActiveSaved(f.id);
    },
    [],
  );
  // First visit in this tab: apply the default saved filter.
  const [defaultApplied, setDefaultApplied] = useState(() => listSession.hasFilter());
  useEffect(() => {
    if (defaultApplied || !saved.data) return;
    const def = saved.data.items.find((f) => f.isDefault);
    if (def) applySaved(def);
    setDefaultApplied(true);
  }, [saved.data, defaultApplied, applySaved]);

  const saveMutation = useMutation({
    mutationFn: (body: { name: string; isDefault: boolean }) =>
      api.post<SavedLeadFilter>('/api/leads/filters', {
        name: body.name,
        isDefault: body.isDefault,
        filter: Object.fromEntries(Object.entries(filter).filter(([k]) => k !== 'sort' && k !== 'direction')),
        columns,
        sort: filter.sort ? { key: filter.sort, direction: filter.direction ?? (filter.sort === 'companyname' || filter.sort === 'city' || filter.sort === 'nextDueAt' ? 'asc' : 'desc') } : null,
      }),
    onSuccess: (f) => {
      setSaveOpen(false);
      setActiveSaved(f.id);
      void queryClient.invalidateQueries({ queryKey: ['leads', 'filters'] });
      toast.success(`Filter «${f.name}» gespeichert`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const updateSaved = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.put(`/api/leads/filters/${id}`, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leads', 'filters'] }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const deleteSaved = useMutation({
    mutationFn: (id: string) => api.del(`/api/leads/filters/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads', 'filters'] });
      toast.info('Filter gelöscht');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const savedSections: MenuSection[] = [
    {
      key: 'list',
      title: 'Meine Filter',
      items: (saved.data?.items ?? []).length
        ? saved.data!.items.map((f) => ({ key: f.id, label: f.name, checked: f.id === activeSaved, hint: f.isDefault ? 'Standard' : undefined, onSelect: () => applySaved(f) }))
        : [{ key: 'none', label: 'Noch keine gespeicherten Filter', disabled: true }],
    },
    {
      key: 'actions',
      items: [
        { key: 'save', label: 'Aktuellen Filter speichern …', icon: Bookmark, onSelect: () => setSaveOpen(true) },
        ...(activeSaved
          ? [
              { key: 'default', label: 'Als Standard setzen', icon: Star, onSelect: () => updateSaved.mutate({ id: activeSaved, body: { isDefault: true } }) },
              { key: 'delete', label: 'Gewählten Filter löschen', icon: Trash2, danger: true, onSelect: () => deleteSaved.mutate(activeSaved) },
            ]
          : []),
      ],
    },
  ];

  const columnSections: MenuSection[] = [
    {
      key: 'cols',
      title: 'Spalten',
      items: COLUMNS.map((c) => ({
        key: c.key,
        label: c.label,
        checked: columns.includes(c.key),
        disabled: c.key === 'company',
        onSelect: () => setColumns((cur) => (cur.includes(c.key) ? cur.filter((k) => k !== c.key) : COLUMNS.map((x) => x.key).filter((k) => cur.includes(k) || k === c.key))),
      })),
    },
    { key: 'reset', items: [{ key: 'reset', label: 'Standard-Spalten', onSelect: () => setColumns(DEFAULT_COLUMNS) }] },
  ];

  // Selection -------------------------------------------------------------------------------------------------------
  const items = data?.items ?? [];
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // After a call the list refreshes (the lead may drop out): the selection follows the chosen lead by id, not by row.
  const followId = useRef<string | null>(null);
  const selectRow = useCallback((index: number, follow: string | null = null) => {
    followId.current = follow;
    setSelected(Math.max(0, index));
  }, []);
  useEffect(() => {
    followId.current = null;
  }, [page, filter]);
  useEffect(() => {
    if (!items.length) return;
    const id = followId.current;
    const at = id ? items.findIndex((l) => l.leadid === id) : -1;
    if (at >= 0) setSelected(at);
    else setSelected((s) => Math.min(s, items.length - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  /** The call with `leadId` is done: mark it worked and select the next row (so «A» calls it right away). */
  const advanceFrom = useCallback(
    (leadId: string | null) => {
      if (!leadId) return;
      listSession.markWorked(leadId);
      const list = itemsRef.current;
      const at = list.findIndex((l) => l.leadid === leadId);
      if (at < 0) return;
      const next = list[at + 1];
      // Last row of the page: stay – after the refresh the next lead moves up into it.
      selectRow(next ? at + 1 : at, next?.leadid ?? null);
    },
    [selectRow],
  );
  const followLead = useCallback((leadId: string) => {
    const at = itemsRef.current.findIndex((l) => l.leadid === leadId);
    setSelected((s) => (at >= 0 ? at : s));
    followId.current = leadId;
  }, []);

  // Call from the list ------------------------------------------------------------------------------------------------
  // Wählen happens here (slim dial bar); «Nicht erreicht» stays in the list; «Verbunden» opens the Lead-Arbeitsplatz
  // as overlay. The server stays the single source of truth (GET /api/calls/active, same endpoints as the workspace).
  const running = isRunning(activeCall) ? activeCall : null;
  const runningRef = useRef(running);
  runningRef.current = running;
  const dialing = running?.status === 'dialing' ? running : null;
  const talking = running && running.status !== 'dialing' ? running : null;

  const onNotReached = (res: NotReachedResponse) => {
    const leadId = res.call.leadId;
    notReachedToast(res, {
      onUndone: (call) => {
        lc.setCall(call);
        if (!leadId) return;
        listSession.unmarkWorked(leadId);
        void queryClient.invalidateQueries({ queryKey: ['leads'] });
        void queryClient.invalidateQueries({ queryKey: ['workspace', leadId] });
        followLead(leadId);
      },
      onMail: () => leadId && navigate(`/lead/${leadId}?panel=mail`),
    });
    advanceFrom(leadId);
  };
  const lc = useLeadCall(running?.leadId ?? items[selected]?.leadid ?? '', running, { onNotReached });

  // «Verbunden» (or a reload during the conversation) opens the overlay – unless it was minimized on purpose.
  const [minimizedId, setMinimizedId] = useState<string | null>(() => minimizedCall.get());
  const overlayOpen = !!talking && talking.id !== minimizedId;
  const minimize = useCallback(() => {
    const id = runningRef.current?.id ?? null;
    minimizedCall.set(id);
    setMinimizedId(id);
  }, []);
  const reopen = useCallback(() => {
    minimizedCall.set(null);
    setMinimizedId(null);
  }, []);
  // The header's call status brings the call up here instead of leaving the list.
  useEffect(
    () =>
      callView.register((leadId) => {
        const r = runningRef.current;
        if (!r || r.leadId !== leadId) return false;
        if (r.status === 'dialing') window.scrollTo({ top: 0, behavior: 'smooth' });
        else reopen();
        return true;
      }),
    [reopen],
  );

  const callLead = (lead: Lead | undefined) => {
    if (!lead || lc.busy) return;
    if (runningRef.current) {
      if (runningRef.current.status !== 'dialing') reopen();
      return;
    }
    if (!callableFromList(lead)) {
      navigate(`/lead/${lead.leadid}`);
      return;
    }
    const at = itemsRef.current.indexOf(lead);
    if (at >= 0) selectRow(at, lead.leadid);
    lc.start.mutate({ leadId: lead.leadid });
  };

  const callLeadLine = (call: { leadId: string | null; leadName: string | null; companyName: string | null }) =>
    items.find((l) => l.leadid === call.leadId) ??
    (call.leadId ? queryClient.getQueryData<WorkspaceData>(['workspace', call.leadId])?.lead : undefined) ?? {
      fullname: call.leadName,
      jobtitle: null,
      companyname: call.companyName ?? '',
    };

  const embedding: WorkspaceEmbedding = {
    onClose: minimize,
    onDone: ({ advance }) => {
      const leadId = talking?.leadId ?? null;
      reopen(); // nothing minimized any more – the next conversation opens again
      if (advance) advanceFrom(leadId);
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
    onNotReached,
  };

  // Keyboard ----------------------------------------------------------------------------------------------------------
  const open = (lead: Lead | undefined) => lead && navigate(`/lead/${lead.leadid}`);
  const down = () => {
    followId.current = null;
    setSelected((s) => Math.min(s + 1, items.length - 1));
  };
  const up = () => {
    followId.current = null;
    setSelected((s) => Math.max(s - 1, 0));
  };
  // Key repeat / a second press before the re-render must never send a step twice (the server refuses it as well).
  const once = (e: KeyboardEvent, fn: () => void) => {
    if (e.repeat || lc.busy) return;
    fn();
  };
  useShortcut('j', down, { description: 'Nächste Zeile', group: 'Anrufliste' });
  useShortcut('k', up, { description: 'Vorherige Zeile', group: 'Anrufliste' });
  useShortcut('arrowdown', down, { description: 'Nächste Zeile', group: 'Anrufliste', enabled: pageFocus });
  useShortcut('arrowup', up, { description: 'Vorherige Zeile', group: 'Anrufliste', enabled: pageFocus });
  useShortcut('o', () => open(items[selected]), { description: 'Gewählten Lead öffnen', group: 'Anrufliste' });
  useShortcut('enter', () => open(items[selected]), { description: 'Gewählten Lead öffnen', group: 'Anrufliste', enabled: pageFocus });
  // The selected row stays visible while J/K/↑/↓ move through the 50 rows.
  useEffect(() => {
    tableRef.current?.querySelector('tr[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, data]);
  useShortcut('a', (e) => once(e, () => callLead(items[selected] ?? items[0])), {
    description: talking ? 'Gespräch öffnen' : 'Gewählten Lead anrufen (bleibt in der Liste)',
    group: 'Anrufliste',
    enabled: !dialing,
  });
  useShortcut('v', (e) => once(e, () => dialing && lc.connected.mutate(dialing.id)), {
    description: 'Verbunden – der Arbeitsplatz öffnet sich',
    group: 'Anruf',
    enabled: !!dialing,
    hidden: !dialing,
  });
  useShortcut('x', (e) => once(e, () => dialing && lc.notReached.mutate(dialing.id)), {
    description: 'Nicht erreicht – weiter zum nächsten Lead',
    group: 'Anruf',
    enabled: !!dialing,
    hidden: !dialing,
  });
  useShortcut('arrowright', () => page < pages && setPage(page + 1), { description: 'Nächste Seite', group: 'Anrufliste' });
  useShortcut('arrowleft', () => page > 1 && setPage(page - 1), { description: 'Vorherige Seite', group: 'Anrufliste' });

  const visible = COLUMNS.filter((c) => columns.includes(c.key));
  const sortKey = filter.sort ?? 'due_then_score';
  const toggleSort = (key: LeadSortKey) => {
    if (sortKey === key) setFilter({ ...filter, direction: (filter.direction ?? (key === 'companyname' || key === 'city' || key === 'nextDueAt' ? 'asc' : 'desc')) === 'asc' ? 'desc' : 'asc' });
    else setFilter({ ...filter, sort: key, direction: undefined });
  };
  const effectiveDir = filter.direction ?? (sortKey === 'companyname' || sortKey === 'city' || sortKey === 'nextDueAt' ? 'asc' : 'desc');
  const first = items[selected] ?? items[0];

  return (
    <>
      {dialing && (
        <DialBar
          call={dialing}
          lead={callLeadLine(dialing)}
          busy={lc.busy}
          onConnected={() => lc.connected.mutate(dialing.id)}
          onNotReached={() => lc.notReached.mutate(dialing.id)}
          onAbandon={() => lc.abandon.mutate(dialing.id)}
        />
      )}
      {talking && !overlayOpen && <ConversationBar call={talking} lead={callLeadLine(talking)} onOpen={reopen} />}
      {talking && <CallOverlay call={talking} lead={callLeadLine(talking)} open={overlayOpen} embedding={embedding} />}
      <PageHeader
        title="Anrufliste"
        description={data ? `${data.total.toLocaleString('de-CH')} Leads zum Anrufen · ${SORT_OPTIONS.find((s) => s.value === sortKey)?.label}` : 'Leads nach Fälligkeit und Score'}
        actions={
          <>
            <DailyGoal />
            <CallTimesHint />
            <Button
              variant="primary"
              size="lg"
              icon={Phone}
              kbd={running ? undefined : 'A'}
              disabled={!first || !!running}
              loading={lc.start.isPending}
              title={running ? 'Zuerst den laufenden Anruf abschliessen' : first ? callHint(first) : undefined}
              onClick={() => callLead(first)}
            >
              {first ? `${first.companyname} anrufen` : 'Anrufen'}
            </Button>
          </>
        }
      />
      <FilterBar
        value={filter}
        onChange={setFilter}
        onReset={() => setFilter({ ...DEFAULT_FILTER })}
        trailing={
          <>
            <Select
              aria-label="Sortierung"
              className="w-56"
              value={sortKey}
              onChange={(e) => setFilter({ ...filter, sort: e.target.value as LeadSortKey, direction: undefined })}
              options={SORT_OPTIONS}
            />
            <DropdownMenu
              trigger={({ toggle }) => (
                <Button icon={Bookmark} onClick={toggle}>
                  {activeSaved ? (saved.data?.items.find((f) => f.id === activeSaved)?.name ?? 'Filter') : 'Gespeicherte Filter'}
                </Button>
              )}
              sections={savedSections}
            />
            <DropdownMenu
              trigger={({ toggle }) => (
                <Button icon={Columns3} onClick={toggle} aria-label="Spalten wählen">
                  Spalten
                </Button>
              )}
              sections={columnSections}
              width={220}
            />
          </>
        }
      />
      <Card className="overflow-hidden">
        {list.isLoading ? (
          <div className="space-y-2 p-5" aria-busy="true">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : list.isError ? (
          <EmptyState title="Anrufliste konnte nicht geladen werden" description={errorMessage(list.error)} action={<Button onClick={() => void list.refetch()}>Nochmals versuchen</Button>} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Keine Leads für diesen Filter"
            description="Filter lockern (z. B. Grade oder Mitarbeitende) oder zurücksetzen. Fälliges findest du auch in den Pendenzen."
            action={
              <div className="flex gap-2">
                <Button onClick={() => setFilter({ ...DEFAULT_FILTER })}>Filter zurücksetzen</Button>
                <Button variant="ghost" onClick={() => navigate('/')}>
                  Zu den Pendenzen
                </Button>
              </div>
            }
          />
        ) : (
          // The table scrolls inside the card (header stays visible); the page header and filters stay in view.
          <div ref={tableRef} className="[&>div]:max-h-[calc(100vh-var(--kls-header-h)-260px)] [&>div]:min-h-[320px]">
          <Table dense className={cn(list.isFetching && 'opacity-70 transition-opacity')}>
            <THead>
              <tr>
                {visible.map((c) => (
                  <TH key={c.key} align={c.align} sortable={!!c.sort} sorted={c.sort && sortKey === c.sort ? effectiveDir : false} onSort={c.sort ? () => toggleSort(c.sort!) : undefined}>
                    {c.label}
                  </TH>
                ))}
                <TH align="right" className="w-12">
                  <span className="sr-only">Anrufen</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {items.map((lead, i) => (
                <TR
                  key={lead.leadid}
                  interactive
                  selected={i === selected}
                  onClick={() => open(lead)}
                  onMouseEnter={() => prefetchLead(lead.leadid)}
                >
                  {visible.map((c) => (
                    <TD key={c.key} align={c.align} className={c.className}>
                      {c.render(lead, now, {
                        onCall: !running && !lc.busy && callableFromList(lead) ? () => callLead(lead) : undefined,
                        callHint: callHint(lead),
                      })}
                    </TD>
                  ))}
                  <TD align="right" className="w-12" onClick={(e) => e.stopPropagation()}>
                    {running?.leadId === lead.leadid ? (
                      <span className="inline-flex size-8 items-center justify-center" title={running.status === 'dialing' ? 'wählt …' : 'im Gespräch'}>
                        <span className={cn('pulse-dot size-2.5 rounded-full', running.status === 'dialing' ? 'bg-call-dialing' : 'bg-call-connected')} aria-hidden />
                        <span className="sr-only">{running.status === 'dialing' ? 'wählt' : 'im Gespräch'}</span>
                      </span>
                    ) : (
                      <IconButton
                        icon={Phone}
                        size="sm"
                        label={callHint(lead)}
                        disabled={!!running || lc.busy || !callableFromList(lead)}
                        onClick={() => callLead(lead)}
                        className="text-primary hover:bg-primary-subtle hover:text-primary"
                      />
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          </div>
        )}
        {data && data.total > PAGE_SIZE && (
          <footer className="flex items-center justify-between border-t border-border px-4 py-2.5 text-[13px] text-fg-muted">
            <span className="tabular">
              {((page - 1) * PAGE_SIZE + 1).toLocaleString('de-CH')}–{Math.min(page * PAGE_SIZE, data.total).toLocaleString('de-CH')} von {data.total.toLocaleString('de-CH')}
            </span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" icon={ChevronLeft} disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Zurück
              </Button>
              <span className="tabular px-2">
                Seite {page} / {pages}
              </span>
              <Button size="sm" variant="ghost" iconRight={ChevronRight} disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Weiter
              </Button>
            </div>
          </footer>
        )}
      </Card>
      <SaveFilterDialog open={saveOpen} onClose={() => setSaveOpen(false)} onSave={(name, isDefault) => saveMutation.mutate({ name, isDefault })} />
    </>
  );
}
