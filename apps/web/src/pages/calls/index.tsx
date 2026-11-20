/**
 * Anruf-UI (INTENT 6.2, 6.3): Wählleiste «Verbunden / Nicht erreicht», Anrufmodus-Kopf, Nachbearbeitung, Notizfeld
 * (debounced Entwurf auf dem Server + lokale Sicherung). Drives the header indicator via `callState`.
 * OWNER: coldcall implementer. Used by the workspace; `CallPanel` is a self-contained variant for other pages.
 */
import { formatZurich, type CallSession, type ChangeSet, type Lead } from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mic, MicOff, PhoneCall, PhoneIncoming, PhoneOff, PhoneOutgoing, ShieldAlert, X } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, errorMessage } from '@/app/api';
import { useAuth } from '@/app/auth';
import { callState, callStore, useElapsed } from '@/app/callState';
import { toast } from '@/app/toast';
import { Badge, Button, cn, Spinner } from '@/components/ui';

// ---------------------------------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------------------------------

export interface DialTarget {
  teamsUrl: string | null;
  telUrl: string | null;
  simulated: boolean;
}

export interface NotReachedResponse {
  call: CallSession;
  changeSet: ChangeSet;
  status: ChangeSet['status'];
  nextAttemptAt: string;
  attempts: number;
  windowDays: number;
  suggestMail: boolean;
}

export interface TodayProgress {
  calls: number;
  conversations: number;
  notReached: number;
}

export const callApi = {
  start: (leadId: string, phoneE164?: string | null, override?: { reason: string } | null) =>
    api.post<{ call: CallSession; dial: DialTarget | null; resumed: boolean }>('/api/calls', {
      leadId,
      ...(phoneE164 ? { phoneE164 } : {}),
      ...(override ? { override } : {}),
    }),
  today: () => api.get<TodayProgress>('/api/calls/today'),
  get: (id: string) => api.get<CallSession>(`/api/calls/${id}`),
  active: () => api.get<{ call: CallSession | null }>('/api/calls/active'),
  connected: (id: string) => api.post<CallSession>(`/api/calls/${id}/connected`),
  hangup: (id: string) => api.post<CallSession>(`/api/calls/${id}/hangup`),
  notReached: (id: string) => api.post<NotReachedResponse>(`/api/calls/${id}/not-reached`),
  undoNotReached: (id: string) => api.post<{ call: CallSession; skipped: string[] }>(`/api/calls/${id}/undo-not-reached`),
  abandon: (id: string) => api.post<CallSession>(`/api/calls/${id}/abandon`),
  note: (id: string, note: string) => api.put<{ noteSavedAt: string }>(`/api/calls/${id}/note`, { note }),
  vera: (id: string, enabled: boolean) => api.put<CallSession>(`/api/calls/${id}/vera`, { enabled }),
};

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);
const RUNNING: CallSession['status'][] = ['dialing', 'connected', 'ended'];
export const isRunning = (c: CallSession | null | undefined): c is CallSession => !!c && RUNNING.includes(c.status);

/** Mirror a call session into the header indicator (bereit · wählt · im Gespräch mm:ss · Nachbearbeitung). */
export function syncCallState(call: CallSession | null): void {
  if (!call || !RUNNING.includes(call.status)) {
    // Only clear the header if it shows this call (another lead's running call stays visible).
    const shown = callStore.get().callSessionId;
    if (!call || shown === call.id || shown == null) callState.reset();
    return;
  }
  callState.restore({
    phase: call.status === 'dialing' ? 'dialing' : call.status === 'connected' ? 'connected' : 'wrapup',
    callSessionId: call.id,
    leadId: call.leadId,
    personName: call.leadName,
    companyName: call.companyName,
    phoneDisplay: call.phoneDisplay,
    dialedAt: ms(call.dialedAt),
    connectedAt: ms(call.connectedAt),
    endedAt: ms(call.endedAt),
  });
}

/** After a reload: the header shows the server's truth about the running call. */
export function useRestoreActiveCall(): CallSession | null {
  const { hasRole } = useAuth();
  const { data } = useQuery({ queryKey: ['calls', 'active'], queryFn: callApi.active, staleTime: 15_000, enabled: hasRole('coldcaller', 'admin') });
  useEffect(() => {
    if (data) syncCallState(data.call);
  }, [data]);
  return data?.call ?? null;
}

/** Open the Teams / tel: link (live) – in the demo nothing is dialed (invented numbers). */
export function openDialTarget(dial: DialTarget | null): void {
  if (!dial || dial.simulated) return;
  const url = dial.teamsUrl ?? dial.telUrl;
  if (!url || !(url.startsWith('https://teams.microsoft.com/') || url.startsWith('tel:'))) return;
  if (url.startsWith('tel:')) window.location.href = url;
  else window.open(url, '_blank', 'noopener,noreferrer');
}

// ---------------------------------------------------------------------------------------------------------------------
// Call session hook for one lead
// ---------------------------------------------------------------------------------------------------------------------

export interface LeadCallHandlers {
  /** After «Nicht erreicht» was saved (navigate to the next lead). */
  onNotReached?: (res: NotReachedResponse) => void;
}

export function useLeadCall(leadId: string, initial: CallSession | null, handlers: LeadCallHandlers = {}) {
  const queryClient = useQueryClient();
  const [call, setCall] = useState<CallSession | null>(initial);
  const initialKey = initial ? `${initial.id}:${initial.status}` : 'none';
  useEffect(() => {
    setCall(initial);
    if (initial) syncCallState(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, initialKey]);

  const apply = useCallback(
    (c: CallSession | null) => {
      setCall(c);
      syncCallState(c);
      queryClient.setQueryData(['calls', 'active'], { call: isRunning(c) ? c : null });
      queryClient.setQueryData<{ activeCall: CallSession | null }>(['workspace', leadId], (ws) => (ws ? { ...ws, activeCall: isRunning(c) ? c : null } : ws));
    },
    [leadId, queryClient],
  );
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const start = useMutation({
    mutationFn: (arg?: string | null | { phoneE164?: string | null; override?: { reason: string } | null }) =>
      typeof arg === 'object' && arg !== null ? callApi.start(leadId, arg.phoneE164, arg.override) : callApi.start(leadId, arg),
    onSuccess: (res) => {
      apply(res.call);
      openDialTarget(res.dial);
      if (res.dial?.simulated && !res.resumed) toast.info('Demo-Modus: Es wird nicht wirklich gewählt', { description: 'Klicke «Verbunden» oder «Nicht erreicht», als ob das Telefon klingeln würde.' });
    },
    onError,
  });
  const connected = useMutation({ mutationFn: (id: string) => callApi.connected(id), onSuccess: apply, onError });
  const hangup = useMutation({
    mutationFn: async (id: string) => {
      // «Aufgelegt» never waits for the note: a failed save stays in the local backup and is retried.
      await flushNote(id).catch(() => undefined);
      return callApi.hangup(id);
    },
    onSuccess: apply,
    onError,
  });
  const abandon = useMutation({ mutationFn: (id: string) => callApi.abandon(id), onSuccess: () => apply(null), onError });
  const vera = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => callApi.vera(id, enabled), onSuccess: apply, onError });
  const notReached = useMutation({
    mutationFn: (id: string) => callApi.notReached(id),
    onSuccess: (res) => {
      apply(isRunning(res.call) ? res.call : null);
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      if (res.status === 'pushed') handlers.onNotReached?.(res);
      else toast.warning('«Nicht erreicht» noch nicht im CRM', { description: 'Bitte unter «Ergebnis & Freigabe» prüfen – der Entwurf ist gespeichert.' });
    },
    onError,
  });
  const busy = start.isPending || connected.isPending || hangup.isPending || notReached.isPending || abandon.isPending;
  return { call, setCall: apply, start, connected, hangup, abandon, vera, notReached, busy };
}

// ---------------------------------------------------------------------------------------------------------------------
// Notes autosave
// ---------------------------------------------------------------------------------------------------------------------

const flushers = new Map<string, () => Promise<boolean>>();
/**
 * Save a pending note right now (before hang-up / push). Throws when the server did not take it: a push must not
 * write an older note into the CRM phone call (after the push the call is closed and the newer text would be lost).
 */
export async function flushNote(callId: string): Promise<void> {
  const ok = (await flushers.get(callId)?.()) ?? true;
  if (!ok) {
    throw new ApiError(0, 'note_not_saved', 'Die Notiz ist noch nicht gespeichert – bitte Verbindung prüfen und nochmals freigeben. Der Text ist lokal gesichert.');
  }
}

const backupKey = (id: string) => `sp.notiz.${id}`;
function readBackup(id: string): { text: string; at: number } | null {
  try {
    const raw = localStorage.getItem(backupKey(id));
    return raw ? (JSON.parse(raw) as { text: string; at: number }) : null;
  } catch {
    return null;
  }
}
function writeBackup(id: string, text: string | null): void {
  try {
    if (text == null) localStorage.removeItem(backupKey(id));
    else localStorage.setItem(backupKey(id), JSON.stringify({ text, at: Date.now() }));
  } catch {
    /* storage unavailable – the server draft still saves */
  }
}

export interface NotesFieldHandle {
  focus(): void;
}

export interface NotesFieldProps {
  call: CallSession;
  autoFocus?: boolean;
  rows?: number;
  className?: string;
  placeholder?: string;
}

/** Note of the running call: autosave (debounced) as server draft, local backup until the server confirmed. */
export const NotesField = forwardRef<NotesFieldHandle, NotesFieldProps>(function NotesField({ call, autoFocus, rows = 8, className, placeholder }, ref) {
  const editable = call.status === 'dialing' || call.status === 'connected' || call.status === 'ended';
  const [text, setText] = useState(() => {
    const backup = readBackup(call.id);
    const serverAt = call.noteSavedAt ? Date.parse(call.noteSavedAt) : 0;
    return backup && backup.at > serverAt ? backup.text : (call.noteDraft ?? '');
  });
  const [state, setState] = useState<{ kind: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'; at?: string }>(() => ({
    kind: call.noteSavedAt ? 'saved' : 'idle',
    at: call.noteSavedAt ?? undefined,
  }));
  const textRef = useRef(text);
  const savedRef = useRef(call.noteDraft ?? '');
  const timer = useRef<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);

  /** true = the server has the current text. */
  const save = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const value = textRef.current;
    if (value === savedRef.current) return true;
    setState({ kind: 'saving' });
    try {
      const res = await callApi.note(call.id, value);
      savedRef.current = value;
      if (textRef.current === value) writeBackup(call.id, null);
      setState({ kind: 'saved', at: res.noteSavedAt });
    } catch {
      setState({ kind: 'error' });
      return false;
    }
    // Typed on while saving → save the newer text too (the push must carry the latest note).
    return textRef.current === value ? true : saveRef.current();
  }, [call.id]);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!editable) return;
    flushers.set(call.id, save);
    // A newer local backup (e.g. lost connection before a reload) is pushed to the server right away.
    if (textRef.current !== savedRef.current) void save();
    return () => {
      flushers.delete(call.id);
      void save();
    };
  }, [call.id, editable, save]);

  useEffect(() => {
    if (autoFocus && editable) area.current?.focus();
  }, [autoFocus, editable]);

  const onChange = (value: string) => {
    setText(value);
    textRef.current = value;
    writeBackup(call.id, value);
    setState({ kind: 'dirty' });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 700);
  };

  const status =
    state.kind === 'saving' ? (
      <span className="inline-flex items-center gap-1.5">
        <Spinner className="size-3" /> speichert …
      </span>
    ) : state.kind === 'error' ? (
      <span className="text-warning">Nicht gespeichert – lokal gesichert, neuer Versuch beim nächsten Tippen</span>
    ) : state.kind === 'saved' && state.at ? (
      <span>Entwurf gespeichert {formatZurich(state.at, 'HH:mm:ss')}</span>
    ) : state.kind === 'dirty' ? (
      <span>…</span>
    ) : (
      <span>Speichert automatisch</span>
    );

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={`notiz-${call.id}`} className="flex items-center justify-between text-[13px] font-medium text-fg">
        Notiz zum Gespräch
        <span className="text-xs font-normal text-fg-subtle" aria-live="polite">
          {status}
        </span>
      </label>
      <textarea
        id={`notiz-${call.id}`}
        ref={area}
        rows={rows}
        disabled={!editable}
        value={text}
        maxLength={20_000}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => void save()}
        placeholder={placeholder ?? 'Was wurde besprochen? Zeitangaben («nach den Ferien»), Systeme, Namen … Die Notiz kommt als Text in die Telefonaktivität.'}
        className="w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-sm leading-relaxed text-fg shadow-sm placeholder:text-fg-subtle focus:border-primary focus:ring-2 focus:ring-ring focus:outline-none disabled:opacity-60"
      />
    </div>
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------------------------------------------------

function personLine(lead: Pick<Lead, 'fullname' | 'jobtitle' | 'companyname'>) {
  return [lead.fullname, lead.jobtitle, lead.companyname].filter(Boolean).join(' · ');
}

export interface DialBarProps {
  call: CallSession;
  lead: Pick<Lead, 'fullname' | 'jobtitle' | 'companyname'>;
  busy?: boolean;
  onConnected: () => void;
  onNotReached: () => void;
  onAbandon: () => void;
}

/** «Wählen»: slim bar with name, function, company, number and reason + the two big buttons. */
export function DialBar({ call, lead, busy, onConnected, onNotReached, onAbandon }: DialBarProps) {
  const elapsed = useElapsed(ms(call.dialedAt));
  return (
    <div className="animate-fade-up sticky top-[calc(var(--kls-header-h)+8px)] z-20 mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-call-dialing/40 bg-surface px-5 py-4 shadow-md">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warning-subtle text-call-dialing">
          <PhoneOutgoing className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-medium text-call-dialing">
            <span className="pulse-dot size-2 rounded-full bg-call-dialing" aria-hidden /> wählt … <span className="tabular text-fg-subtle">{elapsed}</span>
          </p>
          <p className="truncate text-[15px] font-semibold text-fg">{personLine(lead)}</p>
          <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <span className="tabular font-medium text-fg">{call.phoneDisplay ?? 'ohne Nummer'}</span>
            {call.reason && <Badge tone="info">{call.reason}</Badge>}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="lg" variant="primary" icon={PhoneCall} kbd="V" disabled={busy} onClick={onConnected} className="min-w-[170px]">
          Verbunden
        </Button>
        <Button size="lg" icon={PhoneOff} kbd="X" disabled={busy} onClick={onNotReached} className="min-w-[170px]">
          Nicht erreicht
        </Button>
        <Button variant="ghost" size="sm" icon={X} disabled={busy} onClick={onAbandon} title="Nur wenn versehentlich gewählt – es wird nichts gespeichert">
          Abbrechen
        </Button>
      </div>
    </div>
  );
}

export interface CallModeHeaderProps {
  call: CallSession;
  lead: Pick<Lead, 'fullname' | 'jobtitle' | 'companyname'>;
  busy?: boolean;
  onHangup: () => void;
  onToggleVera: (enabled: boolean) => void;
}

const REMINDER_SECONDS = 20;

/** «Im Gespräch mm:ss» – colored, fixed; Vera status with switch; transcription reminder in the first seconds. */
export function CallModeHeader({ call, lead, busy, onHangup, onToggleVera }: CallModeHeaderProps) {
  const connectedAt = ms(call.connectedAt);
  const elapsed = useElapsed(connectedAt);
  const [showReminder, setShowReminder] = useState(() => connectedAt != null && Date.now() - connectedAt < REMINDER_SECONDS * 1000);
  useEffect(() => {
    if (!showReminder || connectedAt == null) return;
    const left = REMINDER_SECONDS * 1000 - (Date.now() - connectedAt);
    const id = window.setTimeout(() => setShowReminder(false), Math.max(0, left));
    return () => window.clearTimeout(id);
  }, [showReminder, connectedAt]);
  const inbound = call.direction === 'inbound';
  return (
    <div className="animate-fade-up sticky top-[calc(var(--kls-header-h)+8px)] z-20 mb-5 overflow-hidden rounded-lg border border-call-connected/50 bg-surface shadow-md">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 bg-call-connected/10 px-5 py-3.5">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-call-connected text-white">
            {inbound ? <PhoneIncoming className="size-5" aria-hidden /> : <PhoneCall className="size-5" aria-hidden />}
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-semibold text-call-connected">
              <span className="pulse-dot size-2 rounded-full bg-call-connected" aria-hidden />
              Im Gespräch <span className="tabular">{elapsed}</span>
              {inbound && <Badge tone="success">Rückruf angenommen</Badge>}
            </p>
            <p className="truncate text-[15px] font-semibold text-fg">{personLine(lead)}</p>
            <p className="tabular text-sm text-fg-muted">
              {call.phoneDisplay ?? ''} {call.reason && <span className="text-fg-subtle">· {call.reason}</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium',
              call.veraEnabled ? 'bg-danger-subtle text-danger' : 'bg-surface-3 text-fg-muted',
            )}
          >
            {call.veraEnabled ? <Mic className="size-4" aria-hidden /> : <MicOff className="size-4" aria-hidden />}
            {call.veraEnabled ? 'Vera zeichnet auf' : 'Vera aus – nur Notizen'}
          </span>
          <Button size="sm" variant="ghost" onClick={() => onToggleVera(!call.veraEnabled)}>
            {call.veraEnabled ? 'Vera ausschalten' : 'Vera einschalten'}
          </Button>
          <Button size="lg" variant="danger" icon={PhoneOff} kbd="E" disabled={busy} onClick={onHangup}>
            Aufgelegt
          </Button>
        </div>
      </div>
      {showReminder && call.veraEnabled && (
        <div role="alert" className="flex items-center gap-3 border-t border-warning/30 bg-warning-subtle px-5 py-2 text-[13px] text-warning">
          <ShieldAlert className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">
            <strong className="font-semibold">Hinweis auf die Transkription nicht vergessen:</strong> «Ich lasse unser Gespräch für meine Notizen transkribieren – ist das für Sie in
            Ordnung?» Will die Person das nicht: Vera ausschalten.
          </span>
          <Button size="sm" variant="secondary" onClick={() => onToggleVera(false)}>
            Vera ausschalten
          </Button>
        </div>
      )}
    </div>
  );
}

/** «Nachbearbeitung»: result → preview → approve. Markus never waits for Vera. */
export function WrapupBar({ call, lead, action }: { call: CallSession; lead: Pick<Lead, 'fullname' | 'jobtitle' | 'companyname'>; action?: ReactNode }) {
  const duration = call.durationSec != null ? `${Math.floor(call.durationSec / 60)}:${String(call.durationSec % 60).padStart(2, '0')} Min.` : null;
  return (
    <div className="animate-fade-up sticky top-[calc(var(--kls-header-h)+8px)] z-20 mb-5 flex flex-wrap items-center gap-4 rounded-lg border border-call-wrapup/40 bg-surface px-5 py-3 shadow-md">
      <span className="size-2.5 rounded-full bg-call-wrapup" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-call-wrapup">Nachbearbeitung{duration ? ` · Gespräch ${duration}` : ''}</p>
        <p className="truncate text-[13px] text-fg-muted">
          {personLine(lead)} – Ergebnis wählen, Vorschau prüfen, freigeben. Die KI-Analyse kommt später in «Analysen zur Freigabe».
        </p>
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Self-contained panel (other pages)
// ---------------------------------------------------------------------------------------------------------------------

export interface CallPanelProps {
  leadId: string;
}

/** Dial bar / call mode for one lead (loads the workspace data itself). */
export function CallPanel({ leadId }: CallPanelProps) {
  const ws = useQuery({
    queryKey: ['workspace', leadId],
    queryFn: () => api.get<{ lead: Lead; activeCall: CallSession | null }>(`/api/workspace/${leadId}`),
  });
  const lc = useLeadCall(leadId, ws.data?.activeCall ?? null);
  if (!ws.data) return null;
  const { call } = lc;
  const lead = ws.data.lead;
  if (!call || !isRunning(call)) {
    return (
      <Button variant="primary" icon={PhoneOutgoing} disabled={lc.busy || !lead.primaryPhone} onClick={() => lc.start.mutate(undefined)}>
        Anrufen
      </Button>
    );
  }
  if (call.status === 'dialing')
    return <DialBar call={call} lead={lead} busy={lc.busy} onConnected={() => lc.connected.mutate(call.id)} onNotReached={() => lc.notReached.mutate(call.id)} onAbandon={() => lc.abandon.mutate(call.id)} />;
  if (call.status === 'connected')
    return <CallModeHeader call={call} lead={lead} busy={lc.busy} onHangup={() => lc.hangup.mutate(call.id)} onToggleVera={(enabled) => lc.vera.mutate({ id: call.id, enabled })} />;
  return <WrapupBar call={call} lead={lead} />;
}

export default CallPanel;
