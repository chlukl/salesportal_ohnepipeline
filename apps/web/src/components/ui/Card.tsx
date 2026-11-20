import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';

export function Card({ className, ...rest }: ComponentProps<'section'>) {
  return <section className={cn('rounded-lg border border-border bg-surface shadow-sm', className)} {...rest} />;
}

export interface CardHeaderProps extends Omit<ComponentProps<'header'>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function CardHeader({ title, description, actions, className, ...rest }: CardHeaderProps) {
  return (
    <header className={cn('flex items-start justify-between gap-4 px-5 pt-4 pb-3', className)} {...rest}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function CardBody({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('px-5 pb-5', className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: ComponentProps<'footer'>) {
  return <footer className={cn('flex items-center justify-end gap-2 border-t border-border px-5 py-3', className)} {...rest} />;
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Page title row: one clear headline, optional description, the main action on the right. */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-[18rem] flex-1">
        <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.01em] text-fg">{title}</h1>
        {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  );
}
