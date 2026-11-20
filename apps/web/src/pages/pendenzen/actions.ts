/**
 * Pure rules of the Pendenzen page (no React / DOM) – tested from the server's vitest
 * (`apps/server/src/modules/pendenzen/webActions.test.ts`).
 */
import type { PendenzEntry } from '@sales-portal/shared';

/** Undo window for «Aufgabe erledigt» – the CRM task is only closed when it has passed (INTENT 6.0: Rückgängig statt Rückfrage). */
export const UNDO_WINDOW_MS = 8000;

export type PrimaryKind = 'open' | 'done' | 'review_analyses';
export interface PrimaryAction {
  label: string;
  kind: PrimaryKind;
}

type ActionItem = Pick<PendenzEntry, 'kind' | 'taskType' | 'link' | 'actions'>;

/** The cancellation links into the workspace's Termin tab only for persons who can book (server decides). */
export function isReplanLink(link: string | null): boolean {
  return !!link && /[?&]panel=scheduling(&|$)/.test(link);
}

/** Main action for an item (page header button for the top item). */
export function primaryAction(item: ActionItem): PrimaryAction {
  switch (item.kind) {
    case 'unfinished_call':
      return { label: 'Anruf abschliessen', kind: 'open' };
    case 'briefing':
      return { label: 'Briefing öffnen', kind: 'open' };
    case 'analysis':
      return { label: 'Analysen prüfen', kind: 'review_analyses' };
    case 'approval':
      return { label: 'Freigabe prüfen', kind: 'open' };
    case 'cancellation':
      if (isReplanLink(item.link)) return { label: 'Neu planen', kind: 'open' };
      // Sales / AI specialist cannot book: the cancellation is information – acknowledge it.
      if (item.actions.includes('mark_done')) return { label: 'Absage erledigt', kind: 'done' };
      return { label: 'Absage ansehen', kind: 'open' };
    case 'task':
      if (item.taskType === 'callback') return { label: 'Rückruf öffnen', kind: 'open' };
      return { label: 'Nächste Pendenz öffnen', kind: 'open' };
    default:
      return { label: 'Nächste Pendenz öffnen', kind: 'open' };
  }
}

/** Opening an analysis Pendenz goes to the collected review list (all analyses on one page), not to the single lead. */
export function opensAnalysisReview(item: Pick<PendenzEntry, 'kind'>): boolean {
  return item.kind === 'analysis';
}

export type DeferredState = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';

export interface DeferredCommit {
  /** Undo: true if the commit had not started yet (nothing was written). */
  cancel(): boolean;
  readonly state: DeferredState;
}

export interface TimerApi {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: never) => void;
}

/**
 * Run `commit` after `delayMs` unless cancelled before – «Rückgängig» for actions the CRM cannot undo
 * (closing a task). Errors are reported through `onFailed`, never thrown.
 */
export function deferCommit(
  commit: () => Promise<void>,
  delayMs: number,
  hooks: { onCommitted?: () => void; onFailed?: (err: unknown) => void } = {},
  timers: TimerApi = globalThis as unknown as TimerApi,
): DeferredCommit {
  let state: DeferredState = 'waiting';
  const id = timers.setTimeout(() => {
    if (state !== 'waiting') return;
    state = 'running';
    commit().then(
      () => {
        state = 'done';
        hooks.onCommitted?.();
      },
      (err: unknown) => {
        state = 'failed';
        hooks.onFailed?.(err);
      },
    );
  }, delayMs);
  return {
    cancel() {
      if (state !== 'waiting') return false;
      state = 'cancelled';
      timers.clearTimeout(id as never);
      return true;
    },
    get state() {
      return state;
    },
  };
}
