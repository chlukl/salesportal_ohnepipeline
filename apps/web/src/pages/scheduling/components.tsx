/** Building blocks of the Terminplaner panels (narrow right column ~480px, notes stay visible next to it). */
import {
  addDaysIso,
  checkAttendeeEmail,
  formatShortDate,
  groupSlotsByDay,
  isoWeek,
  localHhmm,
  localIsoDate,
  workWeekDays,
  type Booking,
  type Slot,
} from '@sales-portal/shared';
import { ChevronLeft, ChevronRight, CircleCheck, Plus, Star, TriangleAlert, Users, X, type LucideIcon } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useShortcut } from '@/app/shortcuts';
import { Badge, Button, cn, EmptyState, IconButton, Kbd, Skeleton, Toggle, Tooltip } from '@/components/ui';
import { ChangeSetPreview } from '@/pages/changesets';
import type { ParticipantInfo } from './api';

// ---------------------------------------------------------------------------------------------------------------------
// Panel shell (fluid width, works inside the workspace column or as a docked side panel)
// ---------------------------------------------------------------------------------------------------------------------

/** Lets a dialog inside the panel take Esc for itself (the native <dialog> closes on Esc). */
const EscapeBlock = createContext<(delta: 1 | -1) => void>(() => undefined);

export function useBlockPanelEscape(active: boolean): void {
  const block = useContext(EscapeBlock);
  useEffect(() => {
    if (!active) return;
    block(1);
    return () => block(-1);
  }, [active, block]);
}

/**
 * `embedded` (default, workspace right column): no own frame, header or scroll container – the column's card, tab and
 * scrolling are used, so the sticky action bar sits at the bottom of the column. Otherwise a framed panel with title.
 * Esc closes in both cases when `onClose` is given.
 */
export function PanelShell({
  title,
  description,
  onClose,
  children,
  footer,
  embedded = true,
  shortcutGroup = 'Terminplaner',
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  embedded?: boolean;
  shortcutGroup?: string;
}) {
  const [blocked, setBlocked] = useState(0);
  const block = useCallback((delta: 1 | -1) => setBlocked((n) => Math.max(0, n + delta)), []);
  useShortcut(
    'escape',
    () => {
      // An open menu closes itself on Esc – the panel stays.
      if (document.querySelector('[role="menu"], dialog[open]')) return;
      onClose?.();
    },
    { description: 'Fenster schliessen', group: shortcutGroup, enabled: !!onClose && blocked === 0 },
  );
  if (embedded) {
    return (
      <EscapeBlock.Provider value={block}>
        <section className="w-full min-w-0 space-y-5" aria-label={typeof title === 'string' ? title : undefined}>
          {children}
          {footer && <footer className="flex items-center justify-end gap-2 border-t border-border pt-3">{footer}</footer>}
        </section>
      </EscapeBlock.Provider>
    );
  }
  return (
    <EscapeBlock.Provider value={block}>
      <section className="flex h-full min-h-0 w-full min-w-0 flex-col rounded-lg border border-border bg-surface shadow-sm">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-fg">{title}</h2>
            {description && <p className="mt-0.5 truncate text-[13px] text-fg-muted">{description}</p>}
          </div>
          {onClose && <IconButton icon={X} label="Schliessen (Esc)" size="sm" onClick={onClose} />}
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-auto px-4 py-4">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">{footer}</footer>}
      </section>
    </EscapeBlock.Provider>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-fg-subtle uppercase">{children}</h3>
      {hint && <span className="text-xs text-fg-subtle">{hint}</span>}
    </div>
  );
}

export function Notice({ tone = 'info', icon: Icon = TriangleAlert, children }: { tone?: 'info' | 'warning' | 'danger' | 'success'; icon?: LucideIcon; children: ReactNode }) {
  const tones = {
    info: 'bg-info-subtle text-info',
    warning: 'bg-warning-subtle text-warning',
    danger: 'bg-danger-subtle text-danger',
    success: 'bg-success-subtle text-success',
  };
  return (
    <div className={cn('flex items-start gap-2 rounded-md px-3 py-2 text-[13px]', tones[tone])}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Participants + Zusatzcall
// ---------------------------------------------------------------------------------------------------------------------

export function ParticipantsRow({
  standard,
  extra,
  extraCall,
  onExtraCall,
}: {
  standard: ParticipantInfo;
  extra: ParticipantInfo;
  extraCall: boolean;
  onExtraCall: (v: boolean) => void;
}) {
  const p = extraCall ? extra : standard;
  return (
    <div className="rounded-md border border-border bg-surface-2 px-3 py-2.5">
      <div className="flex items-center gap-2 text-sm text-fg">
        <Users className="size-4 text-fg-subtle" aria-hidden />
        <span>
          Mit <strong className="font-medium">{p.specialist.displayName}</strong> und <strong className="font-medium">{p.sales.displayName}</strong>
        </span>
        <span className="text-fg-subtle">· 30 Min. Teams</span>
      </div>
      <Toggle
        className="mt-2"
        checked={extraCall}
        onChange={onExtraCall}
        label={
          <span className="flex items-center gap-1.5">
            Zusatzcall <Kbd>Z</Kbd>
          </span>
        }
        description={`${extra.specialist.displayName} + ${extra.sales.displayName}, nur wenn ${standard.sales.displayName} nicht kann`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Week view of free slots
// ---------------------------------------------------------------------------------------------------------------------

export function WeekNav({ weekStart, onChange, todayIso }: { weekStart: string; onChange: (iso: string) => void; todayIso: string }) {
  const days = workWeekDays(weekStart);
  const { week } = isoWeek(weekStart);
  const thisWeek = workWeekDays(todayIso)[0] === weekStart;
  return (
    <div className="flex items-center justify-between gap-2">
      <Tooltip content="Vorherige Woche (⇧←)">
        <IconButton icon={ChevronLeft} label="Vorherige Woche" size="sm" tooltip={false} disabled={thisWeek} onClick={() => onChange(addDaysIso(weekStart, -7))} />
      </Tooltip>
      <div className="text-center">
        <p className="text-sm font-medium text-fg">
          KW {week} · {formatShortDate(`${days[0]}T12:00:00Z`).slice(4)}–{formatShortDate(`${days[4]}T12:00:00Z`).slice(4)}
        </p>
        <p className="text-xs text-fg-subtle">{thisWeek ? 'Diese Woche' : weekStart === addDaysIso(workWeekDays(todayIso)[0], 7) ? 'Nächste Woche' : ' '}</p>
      </div>
      <Tooltip content="Nächste Woche (⇧→)">
        <IconButton icon={ChevronRight} label="Nächste Woche" size="sm" tooltip={false} onClick={() => onChange(addDaysIso(weekStart, 7))} />
      </Tooltip>
    </div>
  );
}

const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

export function WeekSlots({
  weekStart,
  slots,
  loading,
  selected,
  onSelect,
  todayIso,
}: {
  weekStart: string;
  slots: Slot[];
  loading: boolean;
  selected: string | null;
  onSelect: (slot: Slot) => void;
  todayIso: string;
}) {
  const days = workWeekDays(weekStart);
  const byDay = groupSlotsByDay(slots);
  if (loading) {
    return (
      <div className="grid grid-cols-5 gap-1.5" aria-busy>
        {days.map((d) => (
          <div key={d} className="space-y-1.5">
            <Skeleton className="h-9" />
            <Skeleton className="h-7" />
            <Skeleton className="h-7" />
            <Skeleton className="h-7" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="Freie Zeiten dieser Woche">
      {days.map((d, i) => {
        const list = byDay.get(d) ?? [];
        const morning = list.filter((s) => localHhmm(s.start) < '12:00');
        const afternoon = list.filter((s) => localHhmm(s.start) >= '12:00');
        const past = d < todayIso;
        return (
          <div key={d} className={cn('min-w-0 rounded-md', past && 'opacity-50')}>
            <div className={cn('mb-1.5 rounded-md py-1 text-center', d === todayIso ? 'bg-primary-subtle text-primary' : 'text-fg-muted')}>
              <div className="text-[11px] font-semibold uppercase">{WEEKDAY_SHORT[i + 1]}</div>
              <div className="tabular text-[13px] font-medium">{`${d.slice(8, 10)}.${d.slice(5, 7)}.`}</div>
            </div>
            {list.length === 0 ? (
              <p className="px-0.5 py-2 text-center text-[11px] leading-tight text-fg-subtle">{past ? 'vorbei' : 'nichts frei'}</p>
            ) : (
              <div className="space-y-1">
                {morning.map((s) => (
                  <SlotChip key={s.start} slot={s} selected={selected === s.start} onSelect={onSelect} />
                ))}
                {morning.length > 0 && afternoon.length > 0 && <div className="mx-1 my-1.5 border-t border-dashed border-border" aria-hidden />}
                {afternoon.map((s) => (
                  <SlotChip key={s.start} slot={s} selected={selected === s.start} onSelect={onSelect} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SlotChip({ slot, selected, onSelect }: { slot: Slot; selected: boolean; onSelect: (s: Slot) => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(slot)}
      className={cn(
        'tabular h-7 w-full rounded-md border text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        selected ? 'border-primary bg-primary text-primary-fg shadow-sm' : 'border-border bg-surface text-fg hover:border-primary/60 hover:bg-primary-subtle',
      )}
    >
      {localHhmm(slot.start)}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// External attendees (format + domain plausibility)
// ---------------------------------------------------------------------------------------------------------------------

export interface AttendeeDraft {
  email: string;
  name?: string | null;
  isMainContact: boolean;
}

export function AttendeeEditor({
  attendees,
  onChange,
  leadDomain,
  internalDomains,
  label = 'Eingeladen (extern)',
  allowMainContact = true,
}: {
  attendees: AttendeeDraft[];
  onChange: (next: AttendeeDraft[]) => void;
  leadDomain: string | null;
  internalDomains: string[];
  label?: string;
  allowMainContact?: boolean;
}) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const check = checkAttendeeEmail(input, { leadDomain, internalDomains });
    if (!check.ok) {
      setError(check.error);
      return;
    }
    if (attendees.some((a) => a.email.toLowerCase() === check.email.toLowerCase())) {
      setError('Diese Adresse ist schon eingeladen');
      return;
    }
    onChange([...attendees, { email: check.email, isMainContact: allowMainContact && attendees.length === 0 }]);
    setInput('');
    setError(null);
  };
  return (
    <div>
      <SectionTitle>{label}</SectionTitle>
      {attendees.length === 0 && <p className="mb-2 text-[13px] text-fg-muted">Noch niemand – Adresse der Ansprechperson eintragen.</p>}
      <ul className="space-y-1.5">
        {attendees.map((a) => {
          const check = checkAttendeeEmail(a.email, { leadDomain, internalDomains });
          return (
            <li key={a.email} className="rounded-md border border-border px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-fg" title={a.email}>
                  {a.name ? `${a.name} · ` : ''}
                  {a.email}
                </span>
                {allowMainContact &&
                  (a.isMainContact ? (
                    <Badge tone="primary">Hauptkontakt</Badge>
                  ) : (
                    <Tooltip content="Als Hauptkontakt markieren (seine Absage gilt als Absage des Termins)">
                      <IconButton
                        icon={Star}
                        label="Als Hauptkontakt markieren"
                        size="sm"
                        tooltip={false}
                        onClick={() => onChange(attendees.map((x) => ({ ...x, isMainContact: x.email === a.email })))}
                      />
                    </Tooltip>
                  ))}
                <IconButton
                  icon={X}
                  label={`${a.email} entfernen`}
                  size="sm"
                  onClick={() => {
                    const rest = attendees.filter((x) => x.email !== a.email);
                    if (allowMainContact && a.isMainContact && rest.length) rest[0] = { ...rest[0], isMainContact: true };
                    onChange(rest);
                  }}
                />
              </div>
              {check.warning && <p className="mt-0.5 text-xs text-warning">{check.warning}</p>}
            </li>
          );
        })}
      </ul>
      <form
        className="mt-2 flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="min-w-0 flex-1">
          <input
            type="email"
            inputMode="email"
            autoComplete="off"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            placeholder="weitere@firma.ch"
            aria-label="Weitere E-Mail-Adresse"
            aria-invalid={error ? true : undefined}
            className="h-8 w-full rounded-md border border-border-strong bg-surface px-2.5 text-sm text-fg shadow-sm placeholder:text-fg-subtle focus:border-primary focus:ring-2 focus:ring-ring focus:outline-none aria-[invalid=true]:border-danger"
          />
          {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        </div>
        <Button type="submit" size="sm" icon={Plus} disabled={!input.trim()}>
          Hinzufügen
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Approval step (preview owned by the changesets module)
// ---------------------------------------------------------------------------------------------------------------------

export function ApprovalStep({
  title,
  lines,
  changeSetId,
  action,
  previewTitle = 'CRM-Änderungen prüfen',
  previewHint = 'erst nach deiner Freigabe im CRM',
}: {
  title: string;
  lines: ReactNode[];
  changeSetId: string;
  action?: ReactNode;
  previewTitle?: string;
  previewHint?: string;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-success/30 bg-success-subtle px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-success">
          <CircleCheck className="size-4" aria-hidden /> {title}
        </p>
        <ul className="mt-1.5 space-y-0.5 text-[13px] text-fg-muted">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
        {action && <div className="mt-2">{action}</div>}
      </div>
      <div>
        <SectionTitle hint={previewHint}>{previewTitle}</SectionTitle>
        <ChangeSetPreview changeSetId={changeSetId} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Bookings of this lead
// ---------------------------------------------------------------------------------------------------------------------

export const BOOKING_STATUS: Record<Booking['status'], { label: string; tone: 'success' | 'info' | 'danger' | 'neutral' }> = {
  booked: { label: 'gebucht', tone: 'success' },
  rescheduled: { label: 'verschoben', tone: 'info' },
  cancelled: { label: 'abgesagt', tone: 'danger' },
  held: { label: 'durchgeführt', tone: 'neutral' },
};

export function bookingWhen(b: Pick<Booking, 'start'>): string {
  return `${formatShortDate(b.start)} · ${localHhmm(b.start)} Uhr`;
}

export function EmptyWeek({ extraCall, onNext, unavailable }: { extraCall: boolean; onNext: () => void; unavailable: string[] }) {
  if (unavailable.length) {
    return (
      <Notice tone="danger">
        Kalender nicht lesbar ({unavailable.join(', ')}). Ohne aktuelle Kalender bucht das Portal nichts – bitte später nochmals versuchen.
      </Notice>
    );
  }
  return (
    <EmptyState
      compact
      title="Diese Woche ist nichts frei"
      description={
        extraCall
          ? 'Beim Zusatzcall zeigt das Portal nur Zeiten, an denen Manuel nicht kann. Zusatzcall ausschalten oder nächste Woche ansehen.'
          : 'Alle brauchen 30 Minuten frei vor und nach dem Termin. Schau in die nächste Woche.'
      }
      action={
        <Button size="sm" iconRight={ChevronRight} onClick={onNext}>
          Nächste Woche
        </Button>
      }
    />
  );
}

export const todayIsoZurich = () => localIsoDate(new Date());
