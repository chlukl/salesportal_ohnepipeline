/** Display helpers for Pendenzen and Anrufhistorie (Europe/Zurich, Swiss German). */
import { asZurichWallClock, formatZurich, zurichDate, zurichDayDiff, zurichTime, type PendenzDue } from '@sales-portal/shared';

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

export function weekday(date: Date | string): string {
  return WEEKDAYS[asZurichWallClock(date).getDay()];
}

function hasTime(date: Date | string): boolean {
  return formatZurich(date, 'HH:mm') !== '00:00';
}

/** «überfällig seit 16.11.» · «heute 14:00» · «morgen 09:00» · «Fr 20.11.» · «03.12.2026» */
export function formatDue(dueAt: string | null, due: PendenzDue, now = new Date()): string | null {
  if (!dueAt) return null;
  const time = hasTime(dueAt) ? ` ${formatZurich(dueAt, 'HH:mm')}` : '';
  const diff = zurichDayDiff(now, dueAt);
  if (due === 'overdue') return diff === -1 ? 'seit gestern' : `seit ${formatZurich(dueAt, 'dd.MM.')}`;
  if (diff === 0) return `heute${time}`;
  if (diff === 1) return `morgen${time}`;
  if (due === 'this_week' || (diff > 0 && diff < 7)) return `${weekday(dueAt)} ${formatZurich(dueAt, 'dd.MM.')}${time}`;
  return formatZurich(dueAt, diff < 300 ? 'dd.MM.' : 'dd.MM.yyyy') + time;
}

/** Day heading of the history: «Heute», «Gestern», «Mi 18.11.2026». */
export function dayHeading(iso: string, now = new Date()): string {
  const diff = zurichDayDiff(iso, now);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  return `${weekday(iso)} ${formatZurich(iso, 'dd.MM.yyyy')}`;
}

export function formatDuration(sec: number | null): string | null {
  if (sec == null) return null;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Quick «verschieben» targets at 09:00 Zurich. */
export function rescheduleTargets(now = new Date()): { key: string; label: string; at: string }[] {
  const today = zurichDate(now);
  const addDays = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const nextWorkday = dow === 5 ? 3 : dow === 6 ? 2 : 1;
  const nextMonday = dow === 0 ? 1 : 8 - dow;
  const at = (iso: string) => zurichTime(iso, '09:00').toISOString();
  return [
    { key: 'next', label: nextWorkday === 1 ? 'Morgen, 09:00' : `${weekday(at(addDays(nextWorkday)))}, 09:00`, at: at(addDays(nextWorkday)) },
    { key: 'plus2', label: `${weekday(at(addDays(nextWorkday + 1)))} ${formatZurich(at(addDays(nextWorkday + 1)), 'dd.MM.')}, 09:00`, at: at(addDays(nextWorkday + 1)) },
    { key: 'monday', label: `Nächsten Montag (${formatZurich(at(addDays(nextMonday)), 'dd.MM.')})`, at: at(addDays(nextMonday)) },
    { key: 'week', label: `In einer Woche (${formatZurich(at(addDays(7)), 'dd.MM.')})`, at: at(addDays(7)) },
  ];
}

/** `datetime-local` value (Zurich wall clock) → ISO instant. */
export function fromLocalInput(value: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  if (!m) return null;
  return zurichTime(m[1], m[2]).toISOString();
}

export function toLocalInput(iso: string): string {
  return formatZurich(iso, "yyyy-MM-dd'T'HH:mm");
}
