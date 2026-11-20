import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { cn } from './cn';

export interface SidePanelProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** px width, default 440. */
  width?: number;
  className?: string;
}

/**
 * Non-modal side panel docked inside the page layout (e.g. Terminplaner «Seitenfenster» next to the running call –
 * notes stay visible and usable). Esc closes. Place it as the last column of a flex row.
 */
export function SidePanel({ open, onClose, title, description, actions, children, footer, width = 440, className }: SidePanelProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <aside
      aria-label={typeof title === 'string' ? title : undefined}
      style={{ width }}
      className={cn('animate-slide-in flex shrink-0 flex-col rounded-lg border border-border bg-surface shadow-md', className)}
    >
      <PanelHeader title={title} description={description} actions={actions} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
      {footer && <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
    </aside>
  );
}

/** Modal drawer from the right with backdrop (e.g. filter panel, details). */
export function Drawer({ open, onClose, title, description, actions, children, footer, width = 480 }: SidePanelProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Schliessen" className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />
      <div style={{ width }} className="animate-slide-in relative flex h-full max-w-full flex-col border-l border-border bg-surface shadow-lg">
        <PanelHeader title={title} description={description} actions={actions} onClose={onClose} />
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

function PanelHeader({ title, description, actions, onClose }: Pick<SidePanelProps, 'title' | 'description' | 'actions' | 'onClose'>) {
  return (
    <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="truncate text-[15px] font-semibold text-fg">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        <button type="button" aria-label="Schliessen" onClick={onClose} className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg">
          <X className="size-4" />
        </button>
      </div>
    </header>
  );
}
