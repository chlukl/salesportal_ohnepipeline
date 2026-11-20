import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from './cn';

export interface MultiSelectOption<T extends string | number = string> {
  value: T;
  label: string;
  hint?: string;
}

export interface MultiSelectProps<T extends string | number> {
  label: string;
  options: MultiSelectOption<T>[];
  value: T[];
  onChange: (value: T[]) => void;
  /** Show a search box (default: more than 8 options). */
  searchable?: boolean;
  className?: string;
  size?: 'sm' | 'md';
}

/** Filter-style multi select: compact trigger («Branche · 2»), popover with checkboxes and search. */
export function MultiSelect<T extends string | number>({ label, options, value, onChange, searchable, className, size = 'md' }: MultiSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  const showSearch = searchable ?? options.length > 8;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const toggle = (v: T) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  const selectedLabel =
    value.length === 0 ? null : value.length === 1 ? options.find((o) => o.value === value[0])?.label : `${value.length} gewählt`;

  return (
    <div ref={ref} className={cn('relative inline-block', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border text-sm whitespace-nowrap shadow-sm transition-colors',
          size === 'sm' ? 'h-8 px-2.5' : 'h-9 px-3',
          value.length ? 'border-primary/50 bg-primary-subtle text-primary' : 'border-border-strong bg-surface text-fg-muted hover:text-fg',
        )}
      >
        <span className={value.length ? 'font-medium' : ''}>{label}</span>
        {selectedLabel && <span className="max-w-[140px] truncate text-fg">· {selectedLabel}</span>}
        <ChevronDown className="size-3.5 opacity-60" aria-hidden />
      </button>
      {open && (
        <div className="animate-fade-up absolute top-full left-0 z-40 mt-1.5 w-64 rounded-lg border border-border bg-surface p-1.5 shadow-lg">
          {showSearch && (
            <div className="relative mb-1.5">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Suchen …"
                aria-label={`${label} durchsuchen`}
                className="h-8 w-full rounded-md border border-border bg-surface-2 pr-2 pl-7 text-[13px] focus:border-primary focus:outline-none"
              />
            </div>
          )}
          <ul id={listId} role="listbox" aria-multiselectable="true" aria-label={label} className="max-h-64 overflow-auto">
            {filtered.map((o) => {
              const selected = value.includes(o.value);
              return (
                <li key={String(o.value)}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => toggle(o.value)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg hover:bg-surface-2"
                  >
                    <span className={cn('flex size-4 items-center justify-center rounded border', selected ? 'border-primary bg-primary text-primary-fg' : 'border-border-strong')}>
                      {selected && <Check className="size-3" strokeWidth={3} />}
                    </span>
                    <span className="flex-1 truncate">{o.label}</span>
                    {o.hint && <span className="text-xs text-fg-subtle">{o.hint}</span>}
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && <li className="px-2 py-3 text-center text-[13px] text-fg-subtle">Keine Treffer</li>}
          </ul>
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 flex w-full items-center justify-center gap-1 rounded-md border-t border-border px-2 pt-2 pb-1 text-xs text-fg-muted hover:text-fg"
            >
              <X className="size-3" /> Auswahl löschen
            </button>
          )}
        </div>
      )}
    </div>
  );
}
