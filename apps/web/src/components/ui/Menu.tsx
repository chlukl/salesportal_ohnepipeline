import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn';

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: LucideIcon;
  onSelect?: () => void;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  hint?: ReactNode;
}

export interface MenuSection {
  key: string;
  title?: string;
  items: MenuItem[];
}

export interface DropdownMenuProps {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  sections: MenuSection[];
  align?: 'left' | 'right';
  width?: number;
  header?: ReactNode;
}

/** Dropdown menu (user menu, row actions). Closes on outside click, Esc and selection; arrow keys move focus. */
export function DropdownMenu({ trigger, sections, align = 'right', width = 260, header }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
        const idx = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
        items[next]?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          ref={menuRef}
          role="menu"
          style={{ width }}
          className={cn('animate-fade-up absolute top-full z-50 mt-2 rounded-lg border border-border bg-surface p-1.5 shadow-lg', align === 'right' ? 'right-0' : 'left-0')}
        >
          {header}
          {sections.map((section, si) => (
            <div key={section.key} className={cn(si > 0 && 'mt-1.5 border-t border-border pt-1.5')}>
              {section.title && <p className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">{section.title}</p>}
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    type="button"
                    role={item.checked !== undefined ? 'menuitemradio' : 'menuitem'}
                    aria-checked={item.checked}
                    disabled={item.disabled}
                    onClick={() => {
                      item.onSelect?.();
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors disabled:opacity-50',
                      item.danger ? 'text-danger hover:bg-danger-subtle' : 'text-fg hover:bg-surface-2',
                      item.checked && 'font-medium',
                    )}
                  >
                    {Icon && <Icon className="size-4 text-fg-subtle" aria-hidden />}
                    <span className="flex-1">{item.label}</span>
                    {item.hint}
                    {item.checked && <span className="size-1.5 rounded-full bg-primary" aria-hidden />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
