/**
 * Toasts – «Rückgängig» instead of confirmation dialogs (ARCHITECTURE §8).
 *
 *   toast.success('Aufgabe erledigt', { action: { label: 'Rückgängig', onClick: undo } });
 *   toast.error(errorMessage(err));
 */
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { cn } from '@/components/ui/cn';
import { createStore, useStore } from './store';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  duration: number;
}

export interface ToastOptions {
  description?: string;
  action?: { label: string; onClick: () => void };
  /** ms, default 5000 (8000 with action). 0 = sticky. */
  duration?: number;
}

const toastStore = createStore<ToastItem[]>([]);
let nextId = 1;

function push(tone: ToastTone, title: string, options: ToastOptions = {}): number {
  const id = nextId++;
  const duration = options.duration ?? (options.action ? 8000 : 5000);
  toastStore.set((list) => [...list.slice(-4), { id, tone, title, description: options.description, action: options.action, duration }]);
  return id;
}

export function dismissToast(id: number): void {
  toastStore.set((list) => list.filter((t) => t.id !== id));
}

export const toast = {
  success: (title: string, options?: ToastOptions) => push('success', title, options),
  error: (title: string, options?: ToastOptions) => push('error', title, options),
  info: (title: string, options?: ToastOptions) => push('info', title, options),
  warning: (title: string, options?: ToastOptions) => push('warning', title, options),
  dismiss: dismissToast,
};

const ICONS = { success: CheckCircle2, error: XCircle, info: Info, warning: TriangleAlert };
const TONE_CLASS: Record<ToastTone, string> = {
  success: 'text-success',
  error: 'text-danger',
  info: 'text-info',
  warning: 'text-warning',
};

function ToastView({ item }: { item: ToastItem }) {
  const Icon = ICONS[item.tone];
  useEffect(() => {
    if (!item.duration) return;
    const id = window.setTimeout(() => dismissToast(item.id), item.duration);
    return () => window.clearTimeout(id);
  }, [item.id, item.duration]);
  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      className="animate-fade-up pointer-events-auto flex w-[360px] items-start gap-3 rounded-lg border border-border bg-surface p-3.5 shadow-lg"
    >
      <Icon className={cn('mt-0.5 size-[18px] shrink-0', TONE_CLASS[item.tone])} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{item.title}</p>
        {item.description && <p className="mt-0.5 text-[13px] text-fg-muted">{item.description}</p>}
      </div>
      {item.action && (
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-[13px] font-medium text-primary hover:bg-primary-subtle"
          onClick={() => {
            item.action?.onClick();
            dismissToast(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Meldung schliessen"
        className="shrink-0 rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
        onClick={() => dismissToast(item.id)}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

export function Toaster() {
  const items = useStore(toastStore);
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-5 bottom-5 z-[60] flex flex-col items-end gap-2">
      {items.map((t) => (
        <ToastView key={t.id} item={t} />
      ))}
    </div>
  );
}
