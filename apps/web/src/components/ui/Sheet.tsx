import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

export interface SheetProps {
  open: boolean;
  /** Esc, backdrop click and the close control. Never discards anything – the caller decides what closing means. */
  onClose: () => void;
  /** Accessible name of the sheet. */
  label: string;
  /** Slim bar above the scroll area (title, close button). */
  header?: ReactNode;
  children?: ReactNode;
  /** Keep the content mounted (hidden) while closed – state, drafts and open panels survive closing. */
  keepMounted?: boolean;
  /** Element focused on open, if focus is not already inside (CSS selector within the sheet). */
  initialFocus?: string;
  className?: string;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Near-fullscreen modal sheet below the fixed header (the header's call status stays visible). Not a native <dialog>:
 * toasts with «Rückgängig» stay clickable above it. Focus is trapped inside while open; Esc closes unless something
 * inside handled it first (an open menu, a dialog, a panel's own Esc). The scroll area exposes `--ws-top` /
 * `--ws-avail-h` so sticky bars of the Lead-Arbeitsplatz stick to the sheet instead of the window.
 */
export function Sheet({ open, onClose, label, header, children, keepMounted, initialFocus, className }: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Height of the scroll area for the workspace's sticky right column.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !open) return;
    const apply = () => el.style.setProperty('--ws-avail-h', `${el.clientHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  useEffect(() => {
    const root = panel.current;
    if (!open || !root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => {
      if (root.contains(document.activeElement)) return;
      const target = (initialFocus && root.querySelector<HTMLElement>(initialFocus)) || root;
      target.focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      // A native dialog (e.g. «?» or a confirmation inside) handles its own Esc and focus.
      const nested = document.querySelector('dialog[open]');
      if (e.key === 'Escape') {
        if (e.defaultPrevented || e.isComposing || nested || document.querySelector('[role="menu"]')) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || nested) return;
      const items = focusables(root);
      const active = document.activeElement;
      if (!items.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (!root.contains(active) || active === root) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, initialFocus]);

  if (!open && !keepMounted) return null;
  return createPortal(
    <div className="fixed inset-x-0 top-[var(--kls-header-h)] bottom-0 z-40" hidden={!open}>
      <button type="button" tabIndex={-1} aria-label="Schliessen" className="absolute inset-0 cursor-default bg-black/30 backdrop-blur-[1px]" onClick={() => onCloseRef.current()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cn(
          'animate-fade-up absolute inset-x-4 top-3 bottom-4 mx-auto flex max-w-[1760px] flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-lg outline-none',
          className,
        )}
      >
        {header && <div className="shrink-0 border-b border-border bg-surface">{header}</div>}
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto overscroll-contain px-6 pt-4 pb-6" style={{ '--ws-top': '0px' } as CSSProperties}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
