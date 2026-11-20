/**
 * Rückruf-Suche in der Kopfleiste (INTENT 6.18), Kürzel «/». Nummer in beliebigem Format (oder Name/Firma) →
 * Treffer aus Leads, Kontakten, Firmen und Portal-Zuordnungen.
 * - Nummernsuche: Enter = Rückruf annehmen: eingehender Anruf (`POST /api/calls { leadId, direction: 'inbound' }`) und
 *   Lead im Anrufmodus, letzter Anruf + Grund zuoberst. Ctrl+Enter = nur öffnen.
 * - Namens-/Firmensuche: Enter = Lead öffnen (kein Anruf). Ctrl+Enter bzw. Knopf = Rückruf annehmen.
 * Unbekannte Nummer → «nicht im CRM» → einem Lead zuordnen. Regeln in `./callbackRules`.
 */
import { formatZurich, optionLabel, type CallbackHit, type CallbackSearchResponse, type CallSession } from '@sales-portal/shared';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, History, Link2, PhoneIncoming, Search, UserRound } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '@/app/api';
import { useAuth } from '@/app/auth';
import { callState } from '@/app/callState';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Badge, Button, cn, Kbd, Skeleton } from '@/components/ui';
import { AssignLeadDialog, useDebounced } from './AssignLeadDialog';
import { HIT_ACTION_LABELS, hitAction } from './callbackRules';

const SOURCE_LABELS: Record<CallbackHit['source'], string | null> = {
  lead: null,
  name: null,
  contact: 'Kontakt',
  account: 'Firmennummer',
  assignment: 'zugeordnet',
};

function lastCallText(hit: CallbackHit): string | null {
  if (!hit.lastCall) return null;
  const result = optionLabel('kls_anrufergebnis', hit.lastCall.resultCode);
  return [`zuletzt angerufen am ${formatZurich(hit.lastCall.at, 'dd.MM.yyyy')}`, result, hit.lastCall.subject].filter(Boolean).join(' · ');
}

/** Callback reason handed to the call session («warum hatte ich angerufen»). */
function callbackReason(hit: CallbackHit): string {
  if (!hit.lastCall) return 'Rückruf';
  const result = optionLabel('kls_anrufergebnis', hit.lastCall.resultCode);
  return `Rückruf – zuletzt angerufen am ${formatZurich(hit.lastCall.at, 'dd.MM.')}${result ? `: ${result}` : ''}`;
}

export function CallbackSearchField() {
  const { hasRole } = useAuth();
  if (!hasRole('coldcaller', 'admin')) return null;
  return <CallbackSearchInner />;
}

function CallbackSearchInner() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [assign, setAssign] = useState<{ phone: string; display: string | null } | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const q = useDebounced(value.trim(), 200);

  useShortcut('/', () => inputRef.current?.focus(), { description: 'Rückruf-Suche (Nummer, Name, Firma)', group: 'Allgemein' });

  const searchable = q.length >= 2;
  const result = useQuery({
    queryKey: ['callback-search', q],
    queryFn: ({ signal }) => api.get<CallbackSearchResponse>('/api/history/callback-search', { q }, signal),
    enabled: searchable,
    staleTime: 15_000,
  });
  const data = searchable && result.data?.query === q ? result.data : undefined;
  const hits = data?.hits ?? [];
  useEffect(() => setActive(0), [q]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    inputRef.current?.blur();
  };
  const reset = () => {
    setValue('');
    close();
  };
  const searchHistory = () => {
    const term = value.trim();
    if (!term) return;
    navigate(`/historie?suche=${encodeURIComponent(term)}`);
    reset();
  };
  const openLeadOnly = (hit: CallbackHit) => {
    if (!hit.leadId) return;
    navigate(`/lead/${hit.leadId}`);
    reset();
  };

  /** Rückruf angenommen: inbound call session (calls module) + lead in call mode. */
  const takeCallback = async (hit: CallbackHit) => {
    if (!hit.leadId) {
      setAssign({ phone: hit.phoneE164 ?? value.trim(), display: hit.phoneDisplay });
      return;
    }
    setStarting(hit.key);
    try {
      const res = await api.post<{ call?: CallSession } & Partial<CallSession>>('/api/calls', {
        leadId: hit.leadId,
        direction: 'inbound',
        phoneE164: hit.phoneE164 ?? undefined,
        reason: callbackReason(hit),
      });
      const callId = res?.call?.id ?? res?.id ?? null;
      callState.restore({
        phase: 'connected',
        callSessionId: callId,
        leadId: hit.leadId,
        personName: hit.name,
        companyName: hit.companyName,
        phoneDisplay: hit.phoneDisplay,
        dialedAt: Date.now(),
        connectedAt: Date.now(),
      });
      const search = new URLSearchParams({ ...(callId ? { anruf: callId } : {}), richtung: 'eingehend' });
      navigate(`/lead/${hit.leadId}?${search.toString()}`);
    } catch (err) {
      toast.warning('Rückruf konnte nicht als Anruf gestartet werden', { description: `${errorMessage(err)} – der Lead wird trotzdem geöffnet.` });
      navigate(`/lead/${hit.leadId}?richtung=eingehend`);
    } finally {
      setStarting(null);
      reset();
    }
  };

  const mode = data?.mode;
  const runHit = (hit: CallbackHit, alternate = false) => {
    const action = hitAction(mode, hit, alternate);
    if (action === 'callback' || action === 'assign') void takeCallback(hit);
    else if (action === 'open') openLeadOnly(hit);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      reset();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(hits.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey || !hits.length) return searchHistory();
      runHit(hits[Math.min(active, hits.length - 1)], e.ctrlKey || e.metaKey);
    }
  };

  const showPanel = open && value.trim().length > 0;
  return (
    <div ref={boxRef} className="relative w-[340px]">
      <form role="search" onSubmit={(e) => e.preventDefault()}>
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showPanel && hits.length ? `${listId}-${Math.min(active, hits.length - 1)}` : undefined}
          aria-label="Rückruf-Suche: Nummer, Name oder Firma"
          placeholder="Rückruf suchen: Nummer, Name, Firma"
          autoComplete="off"
          spellCheck={false}
          className="h-8 w-full rounded-md border border-border bg-surface-2 pr-9 pl-8 text-[13px] text-fg placeholder:text-fg-subtle focus:border-primary focus:bg-surface focus:ring-2 focus:ring-ring focus:outline-none"
        />
        <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>
      </form>

      {showPanel && (
        <div className="animate-fade-up absolute top-full left-1/2 z-50 mt-2 w-[480px] -translate-x-1/2 rounded-lg border border-border bg-surface shadow-lg">
          <div className="flex items-center justify-between gap-3 border-b border-border px-3.5 py-2 text-xs text-fg-subtle">
            <span>
              {data?.mode === 'phone'
                ? `Nummer ${data.display ?? data.query}`
                : data?.mode === 'name'
                  ? `Leads zu «${data.query}»`
                  : 'Rückruf: Nummer in beliebigem Format eingeben'}
            </span>
            {result.isFetching && <span>sucht …</span>}
          </div>

          {!searchable || data?.mode === 'too_short' ? (
            <p className="px-3.5 py-4 text-[13px] text-fg-muted">Mindestens 6 Ziffern eingeben – z. B. «061 555 01 02» – oder einen Namen bzw. eine Firma.</p>
          ) : !data && result.isLoading ? (
            <div className="space-y-2 p-3.5" aria-busy="true">
              <Skeleton className="h-11" />
              <Skeleton className="h-11" />
            </div>
          ) : result.isError ? (
            <p className="px-3.5 py-4 text-[13px] text-danger">{errorMessage(result.error)}</p>
          ) : data?.unknown ? (
            <div className="px-3.5 py-4">
              <p className="text-sm font-medium text-fg">Nicht im CRM</p>
              <p className="mt-0.5 text-[13px] text-fg-muted">
                Die Nummer {data.display ?? data.query} gehört zu keinem Lead, Kontakt oder Firma. Ordne sie einem Lead zu, dann erkennt das Portal sie beim
                nächsten Mal.
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="primary" icon={Link2} onClick={() => setAssign({ phone: data.e164 ?? data.query, display: data.display })}>
                  Einem Lead zuordnen
                </Button>
                <Button size="sm" variant="ghost" icon={History} onClick={searchHistory}>
                  In der Historie suchen
                </Button>
              </div>
            </div>
          ) : hits.length === 0 ? (
            <p className="px-3.5 py-4 text-[13px] text-fg-muted">Kein Treffer. Mit ⇧ Enter in der Anrufhistorie suchen.</p>
          ) : (
            <ul id={listId} role="listbox" aria-label="Treffer" className="max-h-[420px] overflow-y-auto py-1">
              {hits.map((hit, i) => {
                const source = SOURCE_LABELS[hit.source];
                const last = lastCallText(hit);
                const isActive = i === Math.min(active, hits.length - 1);
                const primary = hitAction(mode, hit);
                const secondary = hit.leadId ? hitAction(mode, hit, true) : null;
                const callFirst = primary === 'callback' || primary === 'assign';
                return (
                  <li
                    key={hit.key}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={isActive}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runHit(hit)}
                    className={cn('flex cursor-pointer items-start gap-3 px-3.5 py-2.5', isActive && 'bg-surface-2')}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
                        callFirst ? 'bg-success-subtle text-success' : 'bg-surface-3 text-fg-muted',
                      )}
                    >
                      {callFirst ? <PhoneIncoming className="size-3.5" aria-hidden /> : <UserRound className="size-3.5" aria-hidden />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-fg">{hit.name}</span>
                        {source && <Badge>{source}</Badge>}
                        {!hit.leadId && <Badge tone="warning">kein Lead</Badge>}
                      </div>
                      <p className="truncate text-xs text-fg-muted">{[hit.companyName !== hit.name ? hit.companyName : null, hit.phoneDisplay].filter(Boolean).join(' · ')}</p>
                      {last && <p className="mt-0.5 truncate text-xs text-fg-subtle">{last}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1 self-center">
                      {starting === hit.key ? (
                        <span className="text-xs text-fg-subtle">öffnet …</span>
                      ) : (
                        isActive && primary !== 'none' && <span className="text-[11px] text-fg-subtle">{HIT_ACTION_LABELS[primary]} ↵</span>
                      )}
                      {secondary && secondary !== 'none' && (
                        <button
                          type="button"
                          aria-label={`${hit.name}: ${HIT_ACTION_LABELS[secondary]}${secondary === 'open' ? ' (ohne Anruf)' : ''}`}
                          title={`${HIT_ACTION_LABELS[secondary]} (Ctrl+Enter)`}
                          onClick={(e) => {
                            e.stopPropagation();
                            runHit(hit, true);
                          }}
                          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-fg-subtle hover:bg-surface-3 hover:text-fg"
                        >
                          {secondary === 'callback' ? <PhoneIncoming className="size-3.5" aria-hidden /> : <ExternalLink className="size-3.5" aria-hidden />}
                          {isActive && <span>{secondary === 'open' ? 'nur öffnen' : HIT_ACTION_LABELS[secondary]}</span>}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex items-center gap-3 border-t border-border px-3.5 py-2 text-[11px] text-fg-subtle">
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> {mode === 'phone' ? 'Rückruf annehmen' : 'Lead öffnen'}
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Ctrl</Kbd>
              <Kbd>↵</Kbd> {mode === 'phone' ? 'nur öffnen' : 'Rückruf annehmen'}
            </span>
            <span className="flex items-center gap-1">
              <Kbd>⇧</Kbd>
              <Kbd>↵</Kbd> in der Historie
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd> schliessen
            </span>
          </div>
        </div>
      )}

      <AssignLeadDialog phone={assign?.phone ?? null} phoneDisplay={assign?.display} onClose={() => setAssign(null)} />
    </div>
  );
}
