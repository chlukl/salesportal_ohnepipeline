import { GRADE_LABELS, type Grade } from '@sales-portal/shared';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Record<BadgeTone, { subtle: string; outline: string; dot: string }> = {
  neutral: { subtle: 'bg-surface-3 text-fg-muted', outline: 'border-border-strong text-fg-muted', dot: 'bg-fg-subtle' },
  primary: { subtle: 'bg-primary-subtle text-primary', outline: 'border-primary/40 text-primary', dot: 'bg-primary' },
  success: { subtle: 'bg-success-subtle text-success', outline: 'border-success/40 text-success', dot: 'bg-success' },
  warning: { subtle: 'bg-warning-subtle text-warning', outline: 'border-warning/40 text-warning', dot: 'bg-warning' },
  danger: { subtle: 'bg-danger-subtle text-danger', outline: 'border-danger/40 text-danger', dot: 'bg-danger' },
  info: { subtle: 'bg-info-subtle text-info', outline: 'border-info/40 text-info', dot: 'bg-info' },
};

export interface BadgeProps extends ComponentProps<'span'> {
  tone?: BadgeTone;
  variant?: 'subtle' | 'outline';
  dot?: boolean;
  size?: 'sm' | 'md';
}

export function Badge({ tone = 'neutral', variant = 'subtle', dot, size = 'sm', className, children, ...rest }: BadgeProps) {
  const t = TONES[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap',
        size === 'sm' ? 'h-5 px-2 text-[11.5px]' : 'h-6 px-2.5 text-xs',
        variant === 'subtle' ? t.subtle : cn('border bg-transparent', t.outline),
        className,
      )}
      {...rest}
    >
      {dot && <span className={cn('size-1.5 rounded-full', t.dot)} aria-hidden />}
      {children}
    </span>
  );
}

const GRADE_CLASS: Record<Grade, string> = {
  A: 'bg-grade-a-bg text-grade-a',
  B: 'bg-grade-b-bg text-grade-b',
  C: 'bg-grade-c-bg text-grade-c',
  D: 'bg-grade-d-bg text-grade-d',
  unrated: 'bg-grade-none-bg text-grade-none',
};

export interface GradeBadgeProps {
  grade: Grade;
  score?: number | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** Score badge in grade color: «A · 82», «unbewertet». */
export function GradeBadge({ grade, score, size = 'md', className }: GradeBadgeProps) {
  const label = grade === 'unrated' ? GRADE_LABELS.unrated : grade;
  return (
    <span
      title={grade === 'unrated' ? 'Noch kein Lead-Score' : `Grade ${grade}${score != null ? `, Score ${score}` : ''}`}
      className={cn(
        'tabular inline-flex items-center gap-1 rounded-md font-semibold whitespace-nowrap',
        size === 'sm' && 'h-5 px-1.5 text-[11px]',
        size === 'md' && 'h-6 px-2 text-xs',
        size === 'lg' && 'h-8 px-2.5 text-sm',
        GRADE_CLASS[grade],
        className,
      )}
    >
      {label}
      {score != null && grade !== 'unrated' && <span className="font-medium opacity-75">· {score}</span>}
    </span>
  );
}
