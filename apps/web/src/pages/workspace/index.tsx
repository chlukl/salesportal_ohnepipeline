/**
 * Lead-Arbeitsplatz (INTENT 6.2, 6.3, 6.17): links Firma/Personen/Spickzettel · Mitte Verlauf/Notiz · rechts Terminplaner,
 * 3 Vorschläge, Mail, Ergebnis & Freigabe. Call flow: Anrufen → wählt (nur das Nötigste) → Verbunden (Anrufmodus) →
 * Aufgelegt (Nachbearbeitung) → Freigeben → nächster Lead. «Nicht erreicht» = ein Klick, dann nächster Lead.
 * OWNER: coldcall implementer.
 */
import { EXCLUSION_LABELS, formatZurich, type ChangeSet, type Lead, type ResultGroupKey } from '@sales-portal/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ArrowRight, Building2, CalendarPlus, CalendarRange, ListChecks, Lock, Mail, PhoneCall, PhoneOutgoing, Undo2, UserPlus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api, errorMessage } from '@/app/api';
import { useAuth } from '@/app/auth';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, GradeBadge, PageHeader, Skeleton, SkeletonText, Tabs, Textarea } from '@/components/ui';
import { AnalysisReviewList, BriefingView, UseCaseMailPanel } from '@/pages/ai';
import { CallModeHeader, callApi, DialBar, isRunning, NotesField, useLeadCall, useRestoreActiveCall, WrapupBar, type NotesFieldHandle, type NotReachedResponse } from '@/pages/calls';
import { ChangeSetPreview, ResultPanel } from '@/pages/changesets';
import { fetchNextLead, listSession, useNextLead } from '@/pages/leads/listQuery';
import { ProposalsPanel, SchedulingPanel, type SchedulingResult } from '@/pages/scheduling';
import { CampaignMails, CheatSheet, HistoryLine, Objections } from './CheatSheet';
import { AssessmentBlock, CompanyBlock, ContactBlock, PersonsBlock, TasksBlock } from './LeftColumn';
import { MeetingColumn } from './MeetingColumn';
import { Timeline } from './Timeline';
import type { RightTab, WorkspaceData } from './types';

export type { WorkspaceData } from './types';

const GRID = 'grid grid-cols-[280px_minmax(0,1fr)_380px] gap-5 2xl:grid-cols-[320px_minmax(0,1fr)_440px]';
/** Sales / KI-Spezialist: the right column carries the briefing (wider). */
const GRID_MEETING = 'grid grid-cols-[280px_minmax(0,1fr)_420px] gap-5 2xl:grid-cols-[320px_minmax(0,1fr)_520px]';

/**
 * Why the lead must not be called now (INTENT 5): campaign lock, Divendo, Zweitkontakt, gleiche Domain, bestehende
 * Firma (owner named), geschlossen. «Nicht mehr kontaktieren» has its own block (donotphone). Empty → callable.
 */
export function lockReasons(lead: Pick<Lead, 'campaign' | 'exclusions' | 'ownerName'>): string[] {
  const out: string[] = [];
  if (lead.campaign.locked) {
    out.push(
      lead.campaign.lockedUntil
        ? `${EXCLUSION_LABELS.campaign_locked} bis ${formatZurich(lead.campaign.lockedUntil, 'dd.MM.yyyy')}`
        : EXCLUSION_LABELS.campaign_locked,
    );
  }
  for (const e of lead.exclusions) {
    if (e === 'campaign_locked' || e === 'do_not_contact') continue;
    out.push(e === 'existing_account' && lead.ownerName ? `${EXCLUSION_LABELS[e]} – Besitzer: ${lead.ownerName}` : EXCLUSION_LABELS[e]);
  }
  return out;
}

export default function WorkspacePage() {
  const { id } = useParams();
  useRestoreActiveCall();
  // A new lead (e.g. "Nächster Lead" after approval) always starts at the top of the page.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [id]);
  if (!id) return <EmptyState icon={Building2} title="Kein Lead gewählt" />;
  return <Workspace key={id} leadId={id} />;
}

function WorkspaceSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="mb-6 h-9 w-96" />
      <div className={GRID}>
        <div className="space-y-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-32" />
        </div>
        <Card className="p-5">
          <SkeletonText lines={10} />
        </Card>
        <Skeleton className="h-96" />
      </div>
    </div>
  );
}

function Workspace({ leadId }: { leadId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const ws = useQuery({ queryKey: ['workspace', leadId], queryFn: () => api.get<WorkspaceData>(`/api/workspace/${leadId}`) });
  const data = ws.data;

  const { hasRole } = useAuth();
  const isAdmin = hasRole('admin');
  const [tab, setTab] = useState<RightTab>(() => (params.get('panel') === 'mail' ? 'mail' : 'result'));
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [preset, setPreset] = useState<{ rule: ResultGroupKey | null; newPerson: boolean; nonce: number }>({ rule: null, newPerson: false, nonce: 0 });
  const notes = useRef<NotesFieldHandle>(null);
  // Deep links from the Pendenzen / notifications: ?briefing=<bookingId>, ?analyse=<analysisId>, ?freigabe=<changeSetId>.
  const [focus, setFocus] = useState<Focus | null>(() => focusFromParams(params));

  // Next lead ---------------------------------------------------------------------------------------------------------
  const goNext = useCallback(
    async (opts: { markWorked?: boolean } = {}) => {
      if (opts.markWorked !== false) listSession.markWorked(leadId);
      try {
        const next = await fetchNextLead(leadId);
        if (next) navigate(`/lead/${next.leadid}`);
        else {
          toast.info('Keine weiteren Leads in deiner Liste', { description: 'Filter in der Anrufliste lockern oder Pendenzen ansehen.' });
          navigate('/anrufliste');
        }
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [leadId, navigate],
  );

  const onNotReached = useCallback(
    (res: NotReachedResponse) => {
      const callId = res.call.id;
      toast.success('Nicht erreicht – gespeichert', {
        description: `Neuer Versuch ab ${formatZurich(res.nextAttemptAt, 'EEEEEE HH:mm').replace(/^\w\w/, (d) => ({ Mo: 'Mo', Tu: 'Di', We: 'Mi', Th: 'Do', Fr: 'Fr', Sa: 'Sa', Su: 'So' })[d] ?? d)} Uhr`,
        action: {
          label: 'Rückgängig',
          onClick: () =>
            void callApi
              .undoNotReached(callId)
              .then(() => {
                listSession.unmarkWorked(leadId);
                void queryClient.invalidateQueries({ queryKey: ['workspace', leadId] });
                void queryClient.invalidateQueries({ queryKey: ['calls'] });
                void queryClient.invalidateQueries({ queryKey: ['leads'] });
                navigate(`/lead/${leadId}`);
                toast.info('Rückgängig gemacht – der Anruf ist wieder offen');
              })
              .catch((err) => toast.error(errorMessage(err))),
        },
      });
      if (res.suggestMail) {
        toast.info(`${res.attempts}× nicht erreicht in ${res.windowDays} Tagen`, {
          description: 'Vielleicht klappt es mit einer Use-Case-Mail.',
          action: { label: 'Mail vorbereiten', onClick: () => navigate(`/lead/${leadId}?panel=mail`) },
          duration: 12_000,
        });
      }
      void goNext();
    },
    [goNext, leadId, navigate, queryClient],
  );

  const lc = useLeadCall(leadId, data?.activeCall ?? null, { onNotReached });
  const call = isRunning(lc.call) ? lc.call : null;
  const phase = !call ? 'idle' : call.status === 'dialing' ? 'dialing' : call.status === 'connected' ? 'connected' : 'wrapup';
  const next = useNextLead(leadId, phase === 'idle' && !!data?.canCall);

  // ?anruf=<id> (Rückruf angenommen, history module) and ?anrufen=1 (from the list) ------------------------------------
  const handledParams = useRef(false);
  useEffect(() => {
    if (!data || handledParams.current) return;
    handledParams.current = true;
    const callId = params.get('anruf');
    const autoStart = params.get('anrufen') === '1';
    if (callId || autoStart || params.get('panel') || focus) {
      const rest = new URLSearchParams(params);
      ['anruf', 'anrufen', 'richtung', 'panel', 'briefing', 'analyse', 'freigabe'].forEach((k) => rest.delete(k));
      setParams(rest, { replace: true });
    }
    if (callId && data.activeCall?.id !== callId) {
      void callApi
        .get(callId)
        .then((c) => isRunning(c) && c.leadId === leadId && lc.setCall(c))
        .catch(() => undefined);
    } else if (autoStart && data.canCall && !data.activeCall && data.lead.primaryPhone && lockReasons(data.lead).length === 0) {
      lc.start.mutate(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Keyboard ----------------------------------------------------------------------------------------------------------
  const canCall = !!data?.canCall;
  const locked = data ? lockReasons(data.lead) : [];
  const callable = canCall && locked.length === 0;
  const startCall = (e164?: string) => callable && phase === 'idle' && !lc.busy && lc.start.mutate(e164);
  // Shortcuts are hidden in the «?» overview while they do nothing (the result groups reuse some letters).
  const on = (enabled: boolean) => ({ enabled, hidden: !enabled });
  // Key repeat / a second press before the re-render must never send a step twice (the server refuses it as well).
  const once = (e: KeyboardEvent, fn: () => void) => {
    if (e.repeat || lc.busy) return;
    fn();
  };
  useShortcut('n', () => void goNext(), { description: 'Nächster Lead', group: 'Arbeitsplatz', ...on(phase === 'idle' && canCall) });
  useShortcut('a', (e) => once(e, () => startCall()), { description: 'Anrufen', group: 'Arbeitsplatz', ...on(phase === 'idle' && callable) });
  useShortcut('v', (e) => once(e, () => call && lc.connected.mutate(call.id)), { description: 'Verbunden', group: 'Anruf', ...on(phase === 'dialing') });
  useShortcut('x', (e) => once(e, () => call && lc.notReached.mutate(call.id)), { description: 'Nicht erreicht', group: 'Anruf', ...on(phase === 'dialing') });
  useShortcut(
    'e',
    (e) =>
      once(e, () => {
        if (phase === 'connected' && call) lc.hangup.mutate(call.id);
        else if (phase === 'wrapup') setTab('result');
      }),
    { description: 'Aufgelegt / Ergebnis', group: 'Anruf', ...on(phase === 'connected' || phase === 'wrapup') },
  );
  useShortcut('mod+.', () => notes.current?.focus(), { description: 'Zur Notiz', group: 'Anruf', allowInInput: true, ...on(!!call) });
  // Quick buttons during the conversation (the cursor is in the note → Alt+digit also works while typing).
  const quick = phase === 'connected' && canCall;
  useShortcut('alt+1', () => openQuick('scheduling'), { description: 'Termin buchen', group: 'Anruf', allowInInput: true, ...on(quick) });
  useShortcut('alt+2', () => openQuick('proposals'), { description: '3 Vorschläge', group: 'Anruf', allowInInput: true, ...on(quick) });
  useShortcut('alt+3', () => openQuick('mail'), { description: 'Use-Case-Mail', group: 'Anruf', allowInInput: true, ...on(quick) });
  useShortcut('alt+4', () => openQuick('result', 'callback'), { description: 'Rückruf vereinbaren', group: 'Anruf', allowInInput: true, ...on(quick) });
  useShortcut('alt+5', () => openQuick('result', 'waiting', true), { description: 'Andere Ansprechperson', group: 'Anruf', allowInInput: true, ...on(quick) });

  // «Aufgelegt» → the wrap-up's main action is in «Ergebnis». A planner / mail tab with possibly unsent content stays
  // (the wrap-up bar then offers «Ergebnis wählen»); after a booking / sent proposals it switches right away.
  const prevPhase = useRef(phase);
  const schedulingDone = useRef(false);
  useEffect(() => {
    if (prevPhase.current === 'connected' && phase === 'wrapup' && tab !== 'result' && tab !== 'mail' && schedulingDone.current) setTab('result');
    prevPhase.current = phase;
  }, [phase, tab]);

  const onPushed = useCallback(
    (cs: ChangeSet) => {
      lc.setCall(null);
      if (call?.direction === 'inbound') return; // Rückruf: stay on the lead
      void cs;
      window.setTimeout(() => void goNext(), 600);
    },
    [call?.direction, goNext, lc],
  );

  // Booked / proposals sent during a call → the call's result group is preselected in «Ergebnis».
  const onSchedulingDone = useCallback((r: SchedulingResult) => {
    schedulingDone.current = true;
    setPreset((p) => ({ rule: r.kind === 'booked' ? 'meeting_booked' : 'proposals_sent', newPerson: false, nonce: p.nonce + 1 }));
  }, []);

  function openQuick(t: RightTab, rule: ResultGroupKey | null = null, newPerson = false) {
    setTab(t);
    if (t === 'result') setPreset((p) => ({ rule: rule ?? p.rule, newPerson, nonce: p.nonce + 1 }));
  }

  if (ws.isLoading) return <WorkspaceSkeleton />;
  if (ws.isError || !data) {
    return (
      <EmptyState
        icon={Building2}
        title="Lead nicht gefunden"
        description={ws.error ? errorMessage(ws.error) : 'Der Lead existiert nicht mehr oder ist nicht sichtbar.'}
        action={<Button onClick={() => navigate('/anrufliste')}>Zur Anrufliste</Button>}
      />
    );
  }
  const { lead } = data;

  const right = canCall ? (
    <RightColumn
      tab={tab}
      setTab={setTab}
      data={data}
      callId={call?.id ?? null}
      callStartedAt={call?.dialedAt ?? null}
      phase={phase}
      preset={preset}
      onPushed={onPushed}
      onStart={callable ? () => startCall() : undefined}
      onSchedulingDone={call ? onSchedulingDone : undefined}
    />
  ) : (
    <MeetingColumn leadId={leadId} initialBookingId={focus?.kind === 'briefing' ? focus.id : null} />
  );

  // --- Wählen: only the essentials ----------------------------------------------------------------------------------
  if (phase === 'dialing' && call) {
    return (
      <>
        <DialBar call={call} lead={lead} busy={lc.busy} onConnected={() => lc.connected.mutate(call.id)} onNotReached={() => lc.notReached.mutate(call.id)} onAbandon={() => lc.abandon.mutate(call.id)} />
        <div className="grid grid-cols-[320px_minmax(0,1fr)] gap-5">
          <ContactBlock lead={lead} callDisabled />
          <Card className="flex items-center justify-center px-6 py-10 text-center text-sm text-fg-muted">
            <div>
              <PhoneOutgoing className="mx-auto mb-3 size-6 text-call-dialing" aria-hidden />
              <p className="font-medium text-fg">Es klingelt …</p>
              <p className="mt-1 max-w-sm">Nimmt jemand ab: «Verbunden» (V) – dann siehst du alles fürs Gespräch. Sonst: «Nicht erreicht» (X), und der nächste Lead steht da.</p>
            </div>
          </Card>
        </div>
      </>
    );
  }

  // --- Anrufmodus ---------------------------------------------------------------------------------------------------
  if (phase === 'connected' && call) {
    return (
      <>
        <CallModeHeader call={call} lead={lead} busy={lc.busy} onHangup={() => lc.hangup.mutate(call.id)} onToggleVera={(enabled) => lc.vera.mutate({ id: call.id, enabled })} />
        <div className={GRID}>
          <div className="space-y-4">
            <CheatSheet data={data} />
            <Objections items={data.objections} />
            <ContactBlock lead={lead} callDisabled />
            <PersonsBlock persons={data.persons} onOpen={(pid) => window.open(`/lead/${pid}`, '_blank', 'noopener')} collapsible />
            <CampaignMails data={data} />
          </div>
          <div className="min-w-0 space-y-4">
            <HistoryLine data={data} />
            <Card className="p-4">
              <NotesField ref={notes} call={call} autoFocus rows={12} />
            </Card>
            <Timeline items={data.timeline} collapsedByDefault />
          </div>
          <div className="space-y-3">
            <QuickButtons onPick={openQuick} />
            {right}
          </div>
        </div>
      </>
    );
  }

  // --- Nachbearbeitung / bereit -------------------------------------------------------------------------------------
  return (
    <>
      {phase === 'wrapup' && call ? (
        <WrapupBar
          call={call}
          lead={lead}
          action={
            tab !== 'result' ? (
              <Button variant="primary" icon={ListChecks} kbd="E" onClick={() => setTab('result')}>
                Ergebnis wählen
              </Button>
            ) : undefined
          }
        />
      ) : (
        <PageHeader
          title={
            <span className="flex items-center gap-3">
              {lead.companyname} <GradeBadge grade={lead.grade} score={lead.kls_leadscore} size="lg" />
            </span>
          }
          description={
            <span className="flex flex-wrap items-center gap-2">
              {[lead.fullname, lead.jobtitle, lead.address1_city].filter(Boolean).join(' · ')}
              {data.callReason && <Badge tone="info">{data.callReason}</Badge>}
            </span>
          }
          actions={
            <>
              <Button variant="ghost" icon={ArrowLeft} onClick={() => (canCall ? navigate('/anrufliste') : navigate(-1))}>
                {canCall ? 'Liste' : 'Zurück'}
              </Button>
              {canCall && (
                <Button
                  variant={locked.length ? 'primary' : 'secondary'}
                  size={locked.length ? 'lg' : 'md'}
                  iconRight={ArrowRight}
                  kbd="N"
                  onClick={() => void goNext()}
                  title={next.data ? `Nächster: ${next.data.companyname}` : undefined}
                >
                  Nächster Lead
                </Button>
              )}
              {canCall && locked.length > 0 && isAdmin && (
                <Button variant="secondary" icon={Lock} disabled={!lead.primaryPhone || lead.donotphone || lc.busy} onClick={() => setOverrideOpen(true)}>
                  Trotzdem anrufen …
                </Button>
              )}
              {callable && (
                <Button variant="primary" size="lg" icon={PhoneOutgoing} kbd="A" loading={lc.start.isPending} disabled={!lead.primaryPhone || lead.donotphone} onClick={() => startCall()}>
                  {lead.primaryPhone ? 'Anrufen' : 'Nummer prüfen'}
                </Button>
              )}
            </>
          }
        />
      )}
      <Notices data={data} locked={locked} />
      <OverrideDialog
        open={overrideOpen}
        reasons={locked}
        busy={lc.start.isPending}
        onClose={() => setOverrideOpen(false)}
        onConfirm={(reason) => lc.start.mutate({ override: { reason } }, { onSuccess: () => setOverrideOpen(false) })}
      />
      <div className={canCall ? GRID : GRID_MEETING}>
        <div className="space-y-4">
          <CompanyBlock lead={lead} />
          <ContactBlock lead={lead} onCall={callable && phase === 'idle' ? (e164) => startCall(e164) : undefined} callDisabled={!callable || phase !== 'idle'} />
          <AssessmentBlock lead={lead} />
          <TasksBlock tasks={data.openTasks} />
          <CampaignMails data={data} />
          <PersonsBlock persons={data.persons} onOpen={(pid) => navigate(`/lead/${pid}`)} />
        </div>
        <div className="min-w-0 space-y-4">
          {focus && !(focus.kind === 'briefing' && !canCall) && (
            <FocusCard
              focus={focus}
              onClose={() => setFocus(null)}
              onDone={() => {
                void queryClient.invalidateQueries({ queryKey: ['workspace', leadId] });
                void queryClient.invalidateQueries({ queryKey: ['pendenzen'] });
                void queryClient.invalidateQueries({ queryKey: ['me', 'counters'] });
              }}
            />
          )}
          {phase === 'wrapup' && call && (
            <Card className="p-4">
              <NotesField ref={notes} call={call} autoFocus rows={7} />
            </Card>
          )}
          <HistoryLine data={data} />
          <Card>
            <CardHeader title="Verlauf" description="Notizen, Anrufe, Mails, Termine – neueste zuerst" />
            <CardBody>
              <Timeline items={data.timeline} />
            </CardBody>
          </Card>
        </div>
        <div>{right}</div>
      </div>
    </>
  );
}

type Focus = { kind: 'briefing' | 'analyse' | 'freigabe'; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function focusFromParams(params: URLSearchParams): Focus | null {
  for (const kind of ['freigabe', 'analyse', 'briefing'] as const) {
    const id = params.get(kind);
    if (id && UUID_RE.test(id)) return { kind, id };
  }
  return null;
}

const FOCUS_TITLE: Record<Focus['kind'], { title: string; description: string }> = {
  freigabe: { title: 'Freigabe', description: 'Änderungen prüfen (alt → neu) und ins CRM übernehmen' },
  analyse: { title: 'KI-Analyse zur Freigabe', description: 'Vorschläge prüfen, ankreuzen und ergänzen' },
  briefing: { title: 'Briefing', description: 'Vorbereitung für das Erstgespräch' },
};

/** The item a Pendenz link points to, shown on top of the middle column until it is closed. */
function FocusCard({ focus, onClose, onDone }: { focus: Focus; onClose: () => void; onDone: () => void }) {
  const t = FOCUS_TITLE[focus.kind];
  return (
    <Card>
      <CardHeader
        title={t.title}
        description={t.description}
        actions={
          <Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label="Schliessen">
            Schliessen
          </Button>
        }
      />
      <CardBody>
        {focus.kind === 'freigabe' && (
          <ChangeSetPreview
            changeSetId={focus.id}
            onDone={() => {
              onDone();
              onClose();
            }}
          />
        )}
        {focus.kind === 'analyse' && <AnalysisReviewList analysisId={focus.id} compact />}
        {focus.kind === 'briefing' && <BriefingView bookingId={focus.id} />}
      </CardBody>
    </Card>
  );
}

function Notices({ data, locked }: { data: WorkspaceData; locked: string[] }) {
  const items: ReactNode[] = [];
  if (data.contactPauseUntil) items.push(<span key="pause">Kontaktpause bis {formatZurich(data.contactPauseUntil, 'dd.MM.yyyy')} (Aufgaben-Regel nach dem letzten Ergebnis).</span>);
  if (locked.length && data.canCall) {
    items.push(
      <span key="locked">
        <strong className="font-semibold">Bitte nicht anrufen</strong> – in der Anrufliste ausgeblendet: {locked.join(' · ')}.
      </span>,
    );
  }
  if (data.notReached.suggestMail) items.push(<span key="mail">{data.notReached.attempts}× nicht erreicht in {data.notReached.windowDays} Tagen – eine Use-Case-Mail könnte helfen.</span>);
  if (!items.length) return null;
  return (
    <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-4 py-2.5 text-[13px] text-warning">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-0.5">{items}</div>
    </div>
  );
}

/** Reason dialog for calling a locked lead (admins only; the server checks and logs it). */
function OverrideDialog({ open, reasons, busy, onClose, onConfirm }: { open: boolean; reasons: string[]; busy: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const ok = reason.trim().length >= 3;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Gesperrten Lead trotzdem anrufen?"
      description={`Gesperrt: ${reasons.join(' · ')}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" icon={PhoneOutgoing} disabled={!ok} loading={busy} onClick={() => onConfirm(reason.trim())}>
            Trotzdem anrufen
          </Button>
        </>
      }
    >
      <Textarea label="Grund (kommt ins Protokoll)" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="z. B. Kunde hat um Rückruf gebeten" />
    </Dialog>
  );
}

const QUICK_KEYS = ['Alt 1', 'Alt 2', 'Alt 3', 'Alt 4', 'Alt 5'];

function QuickButtons({ onPick }: { onPick: (tab: RightTab, rule?: ResultGroupKey | null, newPerson?: boolean) => void }) {
  const items: { label: string; icon: typeof CalendarPlus; onClick: () => void }[] = [
    { label: 'Termin', icon: CalendarPlus, onClick: () => onPick('scheduling') },
    { label: '3 Vorschläge', icon: CalendarRange, onClick: () => onPick('proposals') },
    { label: 'Mail', icon: Mail, onClick: () => onPick('mail') },
    { label: 'Rückruf', icon: Undo2, onClick: () => onPick('result', 'callback') },
    { label: 'andere Person', icon: UserPlus, onClick: () => onPick('result', 'waiting', true) },
  ];
  return (
    <div className="grid grid-cols-5 gap-1.5" role="toolbar" aria-label="Schnellknöpfe">
      {items.map((i, idx) => (
        <button
          key={i.label}
          type="button"
          onClick={i.onClick}
          title={`${i.label} (${QUICK_KEYS[idx]})`}
          aria-keyshortcuts={`Alt+${idx + 1}`}
          className="flex flex-col items-center gap-1 rounded-md border border-border bg-surface px-1 py-2 text-[11.5px] font-medium text-fg-muted shadow-sm hover:border-primary/40 hover:bg-primary-subtle hover:text-primary"
        >
          <i.icon className="size-4" aria-hidden />
          <span className="leading-tight">{i.label}</span>
          <kbd className="rounded bg-surface-3 px-1 font-sans text-[10px] text-fg-subtle">{QUICK_KEYS[idx]}</kbd>
        </button>
      ))}
    </div>
  );
}

function RightColumn({
  tab,
  setTab,
  data,
  callId,
  callStartedAt,
  phase,
  preset,
  onPushed,
  onStart,
  onSchedulingDone,
}: {
  tab: RightTab;
  setTab: (t: RightTab) => void;
  data: WorkspaceData;
  callId: string | null;
  callStartedAt: string | null;
  phase: 'idle' | 'dialing' | 'connected' | 'wrapup';
  preset: { rule: ResultGroupKey | null; newPerson: boolean; nonce: number };
  onPushed: (cs: ChangeSet) => void;
  /** Missing for a locked lead (no «Anrufen» here). */
  onStart?: () => void;
  onSchedulingDone?: (r: SchedulingResult) => void;
}) {
  const leadId = data.lead.leadid;
  const close = () => setTab('result');
  // Coldcall roles only (Sales / KI-Spezialist get the MeetingColumn instead).
  const tabs = [
    { id: 'result' as const, label: 'Ergebnis' },
    { id: 'scheduling' as const, label: 'Termin' },
    { id: 'proposals' as const, label: '3 Vorschläge' },
    { id: 'mail' as const, label: 'Mail' },
  ];
  return (
    <Card className="sticky top-[calc(var(--kls-header-h)+16px)] flex max-h-[calc(100vh-var(--kls-header-h)-32px)] flex-col">
      <div className="px-4 pt-3">
        <Tabs items={tabs} value={tab} onChange={setTab} label="Rechter Bereich" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        {tab === 'result' &&
          (phase === 'idle' ? (
            <EmptyState
              compact
              icon={PhoneCall}
              title="Ergebnis nach dem Anruf"
              description="Zuerst anrufen. Nach «Aufgelegt» wählst du hier die Ergebnisgruppe, prüfst die Vorschau alt → neu und gibst frei."
              action={
                data.lead.primaryPhone && onStart ? (
                  <Button variant="primary" icon={PhoneOutgoing} onClick={onStart}>
                    Anrufen
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ResultPanel
              key={callId ?? 'none'}
              leadId={leadId}
              callSessionId={callId}
              lead={data.lead}
              initialRule={preset.rule}
              initialNewPerson={preset.newPerson}
              callStartedAt={callStartedAt}
              onOpenTab={(t) => setTab(t)}
              onPushed={onPushed}
              hint={
                phase === 'connected' ? (
                  <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-fg-muted">Gespräch läuft – du kannst das Ergebnis schon vorbereiten. «Freigeben» beendet den Anruf.</p>
                ) : undefined
              }
            />
          ))}
        {tab === 'scheduling' && <SchedulingPanel leadId={leadId} callSessionId={callId} onClose={close} onDone={onSchedulingDone} />}
        {tab === 'proposals' && <ProposalsPanel leadId={leadId} callSessionId={callId} onClose={close} onDone={onSchedulingDone} />}
        {tab === 'mail' && <UseCaseMailPanel leadId={leadId} callSessionId={callId} onClose={close} />}
      </div>
    </Card>
  );
}
