/**
 * Calling from the Anrufliste (INTENT 6.2 «Wählen und Anrufmodus»): after «Verbunden» the full Lead-Arbeitsplatz opens
 * as a large overlay over the list (the list stays mounted behind it – filter, scroll position, selection). Closing it
 * never discards anything: a running call is only minimized, the bar on top of the list and the header status bring it
 * back. OWNER: coldcall implementer.
 */
import type { CallSession, Lead } from '@sales-portal/shared';
import { ListChecks, Minimize2, PhoneCall } from 'lucide-react';
import { useElapsed } from '@/app/callState';
import { ShortcutLayer, useShortcut } from '@/app/shortcuts';
import { Button, cn, Sheet } from '@/components/ui';
import { Workspace, type WorkspaceEmbedding } from '@/pages/workspace';

type LeadLine = Pick<Lead, 'fullname' | 'jobtitle' | 'companyname'>;

const line = (lead: LeadLine) => [lead.fullname, lead.jobtitle, lead.companyname].filter(Boolean).join(' · ');
const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);

/** Which call has been minimized in this tab (survives a reload: a minimized call stays minimized). */
const MINIMIZED_KEY = 'sp.anrufliste.minimiert';
export const minimizedCall = {
  get(): string | null {
    try {
      return sessionStorage.getItem(MINIMIZED_KEY);
    } catch {
      return null;
    }
  },
  set(callId: string | null): void {
    try {
      if (callId) sessionStorage.setItem(MINIMIZED_KEY, callId);
      else sessionStorage.removeItem(MINIMIZED_KEY);
    } catch {
      /* storage unavailable – the overlay then simply opens again after a reload */
    }
  },
};

export interface CallOverlayProps {
  call: CallSession;
  lead: LeadLine;
  open: boolean;
  embedding: WorkspaceEmbedding;
}

/** The Lead-Arbeitsplatz of the running call as overlay; stays mounted while minimized (open panels, inputs). */
export function CallOverlay({ call, lead, open, embedding }: CallOverlayProps) {
  const leadId = call.leadId;
  if (!leadId) return null;
  return (
    <Sheet
      open={open}
      onClose={embedding.onClose}
      label={`Gespräch mit ${line(lead)}`}
      keepMounted
      initialFocus="textarea"
      header={
        <div className="flex items-center gap-3 px-4 py-2">
          <p className="min-w-0 flex-1 truncate text-[13px] text-fg-muted">
            <span className="font-medium text-fg">Anrufmodus</span> · {line(lead)}
            <span className="hidden text-fg-subtle min-[1440px]:inline"> · die Anrufliste bleibt im Hintergrund</span>
          </p>
          <Button
            variant="ghost"
            size="sm"
            icon={Minimize2}
            kbd="escape"
            onClick={embedding.onClose}
            title="Zur Liste – das Gespräch läuft weiter und lässt sich über die Leiste oben wieder öffnen"
          >
            Zur Liste
          </Button>
        </div>
      }
    >
      <ShortcutLayer active={open}>
        <EscapeHint />
        <Workspace key={leadId} leadId={leadId} embedded={embedding} />
      </ShortcutLayer>
    </Sheet>
  );
}

/**
 * Esc is handled by the Sheet (only when nothing inside – an open panel, menu or dialog – took it first); this entry
 * only lists it in the «?» overview of the overlay.
 */
function EscapeHint() {
  useShortcut('escape', () => undefined, { description: 'Zur Liste (das Gespräch läuft weiter)', group: 'Anrufmodus', enabled: false });
  return null;
}

/** Minimized conversation on top of the list: «im Gespräch mm:ss» / «Nachbearbeitung» + «Gespräch öffnen». */
export function ConversationBar({ call, lead, onOpen }: { call: CallSession; lead: LeadLine; onOpen: () => void }) {
  const connected = call.status === 'connected';
  const elapsed = useElapsed(connected ? ms(call.connectedAt) : null);
  return (
    <div
      className={cn(
        'animate-fade-up sticky top-[calc(var(--ws-top)+8px)] z-20 mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border bg-surface px-5 py-3 shadow-md',
        connected ? 'border-call-connected/50' : 'border-call-wrapup/40',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <span className={cn('size-2.5 shrink-0 rounded-full', connected ? 'pulse-dot bg-call-connected' : 'bg-call-wrapup')} aria-hidden />
        <div className="min-w-0">
          <p className={cn('text-sm font-semibold', connected ? 'text-call-connected' : 'text-call-wrapup')}>
            {connected ? (
              <>
                Im Gespräch <span className="tabular">{elapsed}</span>
              </>
            ) : (
              'Nachbearbeitung – Ergebnis wählen und freigeben'
            )}
          </p>
          <p className="truncate text-[13px] text-fg-muted">
            {line(lead)}
            {call.phoneDisplay && <span className="tabular"> · {call.phoneDisplay}</span>}
          </p>
        </div>
      </div>
      <Button variant="primary" icon={connected ? PhoneCall : ListChecks} kbd="A" onClick={onOpen}>
        Gespräch öffnen
      </Button>
    </div>
  );
}
