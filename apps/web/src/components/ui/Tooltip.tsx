import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { cn } from './cn';

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'right' | 'left';
  className?: string;
}

/** Lightweight tooltip on hover/focus (CSS positioned, no portal). */
export function Tooltip({ content, children, side = 'bottom', className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && (
        <span
          id={id}
          role="tooltip"
          className={cn(
            'animate-fade-up pointer-events-none absolute z-50 rounded-md bg-fg px-2 py-1 text-xs font-medium whitespace-nowrap text-bg shadow-md',
            side === 'bottom' && 'top-full left-1/2 mt-1.5 -translate-x-1/2',
            side === 'top' && 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
            side === 'right' && 'top-1/2 left-full ml-2 -translate-y-1/2',
            side === 'left' && 'top-1/2 right-full mr-2 -translate-y-1/2',
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
