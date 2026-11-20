import type { LucideIcon } from 'lucide-react';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from './cn';

const controlBase =
  'w-full rounded-md border border-border-strong bg-surface text-sm text-fg placeholder:text-fg-subtle shadow-sm transition-colors ' +
  'hover:border-fg-subtle focus:border-primary focus:ring-2 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 ' +
  'aria-[invalid=true]:border-danger';

interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
}

/** Label + control + hint/error, wired with ids for accessibility. */
export function Field({ label, hint, error, className, id, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={id} className="text-[13px] font-medium text-fg">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-fg-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends Omit<ComponentProps<'input'>, 'size'>, FieldProps {
  icon?: LucideIcon;
  /** Element on the right inside the input (e.g. <Kbd>/</Kbd>). */
  trailing?: ReactNode;
  inputSize?: 'sm' | 'md';
}

export function Input({ label, hint, error, className, icon: Icon, trailing, inputSize = 'md', id, ...rest }: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <Field label={label} hint={hint} error={error} id={inputId} className={className}>
      <div className="relative">
        {Icon && <Icon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />}
        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          className={cn(controlBase, inputSize === 'sm' ? 'h-8' : 'h-9', Icon ? 'pl-8.5' : 'pl-3', trailing ? 'pr-10' : 'pr-3')}
          {...rest}
        />
        {trailing && <div className="absolute top-1/2 right-2 -translate-y-1/2">{trailing}</div>}
      </div>
    </Field>
  );
}

export interface TextareaProps extends ComponentProps<'textarea'>, FieldProps {}

export function Textarea({ label, hint, error, className, id, rows = 4, ...rest }: TextareaProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <Field label={label} hint={hint} error={error} id={inputId} className={className}>
      <textarea
        id={inputId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
        className={cn(controlBase, 'resize-y px-3 py-2 leading-relaxed')}
        {...rest}
      />
    </Field>
  );
}

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<ComponentProps<'select'>, 'children'>, FieldProps {
  options: SelectOption[];
  placeholder?: string;
  selectSize?: 'sm' | 'md';
}

export function Select({ label, hint, error, className, options, placeholder, selectSize = 'md', id, ...rest }: SelectProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <Field label={label} hint={hint} error={error} id={inputId} className={className}>
      <select
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={cn(
          controlBase,
          'appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat pr-8 pl-3',
          "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238693a4' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]",
          selectSize === 'sm' ? 'h-8' : 'h-9',
        )}
        {...rest}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, className, id, ...rest }: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label htmlFor={inputId} className={cn('flex cursor-pointer items-start gap-2.5 text-sm', rest.disabled && 'cursor-not-allowed opacity-60', className)}>
      <input id={inputId} type="checkbox" className="mt-0.5 size-4 shrink-0 cursor-pointer rounded accent-[var(--kls-primary)]" {...rest} />
      <span>
        <span className="text-fg">{label}</span>
        {description && <span className="block text-xs text-fg-muted">{description}</span>}
      </span>
    </label>
  );
}

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** On/off switch (role="switch"), e.g. «Zusatzcall», «Vera zeichnet auf». */
export function Toggle({ checked, onChange, label, description, disabled, className }: ToggleProps) {
  const id = useId();
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div>
        <label htmlFor={id} className="text-sm text-fg">
          {label}
        </label>
        {description && <p className="text-xs text-fg-muted">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-primary' : 'bg-border-strong',
        )}
      >
        <span className={cn('inline-block size-4 rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
    </div>
  );
}
