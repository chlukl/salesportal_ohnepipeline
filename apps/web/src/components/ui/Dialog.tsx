import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from './cn';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

/** Modal dialog on the native <dialog> element (focus trap, Esc, backdrop handled by the browser). Use sparingly – prefer «Rückgängig». */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        'm-auto w-full rounded-lg border border-border bg-surface p-0 text-fg shadow-lg',
        size === 'sm' && 'max-w-sm',
        size === 'md' && 'max-w-lg',
        size === 'lg' && 'max-w-3xl',
      )}
    >
      {open && (
        <div className="animate-fade-up">
          <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-2">
            <div>
              <h2 className="text-base font-semibold">{title}</h2>
              {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
            </div>
            <button type="button" aria-label="Schliessen" onClick={onClose} className="rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg">
              <X className="size-4" />
            </button>
          </header>
          <div className="px-6 py-3">{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-border px-6 py-3.5">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
