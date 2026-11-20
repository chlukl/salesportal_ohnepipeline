import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from './cn';

/** Data table: sticky header, quiet row separators, hover, optional dense rows. Wrap in a Card for a border. */
export function Table({ className, dense, ...rest }: ComponentProps<'table'> & { dense?: boolean }) {
  return (
    <div className="w-full overflow-auto">
      <table data-dense={dense || undefined} className={cn('group/table w-full border-collapse text-left text-sm', className)} {...rest} />
    </div>
  );
}

export function THead({ className, ...rest }: ComponentProps<'thead'>) {
  return <thead className={cn('sticky top-0 z-10 bg-surface', className)} {...rest} />;
}

export function TBody(props: ComponentProps<'tbody'>) {
  return <tbody {...props} />;
}

export interface TRProps extends ComponentProps<'tr'> {
  selected?: boolean;
  interactive?: boolean;
}

export function TR({ className, selected, interactive, ...rest }: TRProps) {
  return (
    <tr
      aria-selected={selected || undefined}
      className={cn(
        'border-b border-border last:border-b-0',
        interactive && 'cursor-pointer hover:bg-surface-2',
        selected && 'bg-primary-subtle/60',
        className,
      )}
      {...rest}
    />
  );
}

export interface THProps extends ComponentProps<'th'> {
  sortable?: boolean;
  sorted?: 'asc' | 'desc' | false;
  onSort?: () => void;
  align?: 'left' | 'right' | 'center';
}

export function TH({ className, sortable, sorted, onSort, align = 'left', children, ...rest }: THProps) {
  const SortIcon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown;
  return (
    <th
      scope="col"
      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
      className={cn(
        'h-10 border-b border-border px-3 text-xs font-medium whitespace-nowrap text-fg-subtle',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
      {...rest}
    >
      {sortable ? (
        <button type="button" onClick={onSort} className={cn('inline-flex items-center gap-1 hover:text-fg', sorted && 'text-fg')}>
          {children}
          <SortIcon className={cn('size-3.5', !sorted && 'opacity-40')} aria-hidden />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function TD({ className, align = 'left', ...rest }: ComponentProps<'td'> & { align?: 'left' | 'right' | 'center' }) {
  return (
    <td
      className={cn(
        'px-3 py-3 align-middle text-fg group-data-[dense]/table:py-2',
        align === 'right' && 'tabular text-right',
        align === 'center' && 'text-center',
        className,
      )}
      {...rest}
    />
  );
}
