import { Loader2, type LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';
import { kbdLabel } from './keys';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover shadow-sm',
  secondary: 'bg-surface text-fg border border-border-strong hover:bg-surface-2 shadow-sm',
  ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger text-white hover:opacity-90 shadow-sm',
  subtle: 'bg-primary-subtle text-primary hover:brightness-95',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-[15px] gap-2',
};

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  /**
   * Keyboard hint shown on the right: a combo as registered with `useShortcut` (`'mod+enter'`) or a label (`'N'`,
   * `'Ctrl ↵'`). «Ctrl» is shown as «⌘» on a Mac, like in the «?» overview.
   */
  kbd?: string;
}

export function Button({ variant = 'secondary', size = 'md', loading, icon: Icon, iconRight: IconRight, kbd, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors select-none',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : Icon ? <Icon className="size-4" aria-hidden /> : null}
      {children}
      {IconRight && <IconRight className="size-4" aria-hidden />}
      {kbd && (
        <kbd className={cn('ml-1 rounded px-1 font-sans text-[11px] font-medium', variant === 'primary' ? 'bg-white/20' : 'bg-surface-3 text-fg-muted')}>
          {kbdLabel(kbd)}
        </kbd>
      )}
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  icon: LucideIcon;
  /** Accessible name + tooltip. */
  label: string;
  variant?: 'ghost' | 'secondary' | 'primary';
  size?: 'sm' | 'md';
  tooltip?: boolean;
  badge?: ReactNode;
}

export function IconButton({ icon: Icon, label, variant = 'ghost', size = 'md', tooltip = true, badge, className, type = 'button', ...rest }: IconButtonProps) {
  const button = (
    <button
      type={type}
      aria-label={label}
      className={cn(
        'relative inline-flex items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'size-8' : 'size-9',
        variant === 'ghost' && 'text-fg-muted hover:bg-surface-2 hover:text-fg',
        variant === 'secondary' && 'border border-border-strong bg-surface text-fg hover:bg-surface-2',
        variant === 'primary' && 'bg-primary text-primary-fg hover:bg-primary-hover',
        className,
      )}
      {...rest}
    >
      <Icon className="size-[18px]" aria-hidden />
      {badge}
    </button>
  );
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
}
