import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  variant?: 'underline' | 'pill';
  className?: string;
  /** aria-label of the tab list. */
  label?: string;
}

/** Controlled tabs with arrow-key navigation (WAI-ARIA tabs pattern). Render the panel yourself based on `value`. */
export function Tabs<T extends string>({ items, value, onChange, variant = 'underline', className, label }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    for (let i = 1; i <= items.length; i++) {
      const next = (index + dir * i + items.length) % items.length;
      if (!items[next].disabled) {
        onChange(items[next].id);
        refs.current[next]?.focus();
        break;
      }
    }
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(variant === 'underline' ? 'flex gap-5 border-b border-border' : 'inline-flex gap-1 rounded-lg bg-surface-2 p-1', className)}
    >
      {items.map((item, i) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'inline-flex items-center gap-2 text-sm font-medium transition-colors disabled:opacity-40',
              variant === 'underline' && '-mb-px border-b-2 px-0.5 pb-2.5',
              variant === 'underline' && (active ? 'border-primary text-fg' : 'border-transparent text-fg-muted hover:text-fg'),
              variant === 'pill' && 'h-8 rounded-md px-3',
              variant === 'pill' && (active ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'),
            )}
          >
            {item.label}
            {item.count != null && (
              <span className={cn('tabular rounded-full px-1.5 text-[11px] leading-[18px]', active ? 'bg-primary-subtle text-primary' : 'bg-surface-3 text-fg-muted')}>
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
