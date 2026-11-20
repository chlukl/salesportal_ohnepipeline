/** Time helpers: everything user-facing is Europe/Zurich. */
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';

export const ZURICH_TZ = 'Europe/Zurich';

/** Format a date in Zurich time, e.g. `formatZurich(d, 'dd.MM.yyyy HH:mm')`. */
export function formatZurich(date: Date | string, pattern = 'dd.MM.yyyy HH:mm'): string {
  return formatInTimeZone(typeof date === 'string' ? new Date(date) : date, ZURICH_TZ, pattern);
}

/** `YYYY-MM-DD` of the date in Zurich. */
export function zurichDate(date: Date | string): string {
  return formatZurich(date, 'yyyy-MM-dd');
}

/** UTC instant of a Zurich wall-clock time, e.g. `zurichTime('2026-11-24', '09:00')`. */
export function zurichTime(isoDate: string, hhmm: string): Date {
  return fromZonedTime(`${isoDate}T${hhmm}:00`, ZURICH_TZ);
}

/** Start of the Zurich day (as UTC instant). */
export function startOfZurichDay(date: Date | string): Date {
  return zurichTime(zurichDate(date), '00:00');
}

/** Date whose local fields show Zurich wall-clock time (for date-fns calculations like getDay/getHours). */
export function asZurichWallClock(date: Date | string): Date {
  return toZonedTime(typeof date === 'string' ? new Date(date) : date, ZURICH_TZ);
}

/** Calendar-day difference (Zurich) between two instants: 0 = same day, 1 = tomorrow … */
export function zurichDayDiff(from: Date | string, to: Date | string): number {
  const a = startOfZurichDay(from).getTime();
  const b = startOfZurichDay(to).getTime();
  return Math.round((b - a) / 86_400_000);
}
