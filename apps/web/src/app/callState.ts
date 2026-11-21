/**
 * Global call state for the header indicator (bereit · wählt · im Gespräch mm:ss · Nachbearbeitung).
 * The coldcall module drives it: `callState.dialing({...})`, `callState.connected()`, `callState.wrapup()`, `callState.reset()`.
 */
import type { CallPhase } from '@sales-portal/shared';
import { useEffect, useState } from 'react';
import { createStore, useStore } from './store';

export interface CallState {
  phase: CallPhase;
  callSessionId: string | null;
  leadId: string | null;
  personName: string | null;
  companyName: string | null;
  phoneDisplay: string | null;
  dialedAt: number | null;
  connectedAt: number | null;
  endedAt: number | null;
}

const idle: CallState = {
  phase: 'idle',
  callSessionId: null,
  leadId: null,
  personName: null,
  companyName: null,
  phoneDisplay: null,
  dialedAt: null,
  connectedAt: null,
  endedAt: null,
};

export const callStore = createStore<CallState>(idle);

export const callState = {
  dialing(info: Pick<CallState, 'leadId' | 'personName' | 'companyName' | 'phoneDisplay'> & { callSessionId?: string | null }) {
    callStore.set({ ...idle, ...info, callSessionId: info.callSessionId ?? null, phase: 'dialing', dialedAt: Date.now() });
  },
  connected(at: number = Date.now()) {
    callStore.set((s) => ({ ...s, phase: 'connected', connectedAt: at }));
  },
  wrapup(at: number = Date.now()) {
    callStore.set((s) => ({ ...s, phase: 'wrapup', endedAt: at }));
  },
  /** Restore after reload (from GET /api/calls/active). */
  restore(state: Partial<CallState> & { phase: CallPhase }) {
    callStore.set({ ...idle, ...state });
  },
  reset() {
    callStore.set(idle);
  },
};

/**
 * A page that shows the running call itself (the Anrufliste with its dial bar / call overlay) registers here; a click on
 * the header status then brings that view up instead of navigating to `/lead/:id`.
 */
let callViewOpener: ((leadId: string) => boolean) | null = null;
export const callView = {
  register(open: (leadId: string) => boolean): () => void {
    callViewOpener = open;
    return () => {
      if (callViewOpener === open) callViewOpener = null;
    };
  },
  /** true = handled by the current page. */
  open(leadId: string): boolean {
    return callViewOpener?.(leadId) ?? false;
  },
};

export function useCallState(): CallState {
  return useStore(callStore);
}

/** mm:ss since `since` (updates every second while mounted). */
export function useElapsed(since: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [since]);
  if (since == null) return '00:00';
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
