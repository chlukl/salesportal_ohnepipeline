/**
 * REGEL_AUFGABEN (INTENT 5, 6.5): newest info wins, no second open task per company, max. 3 tasks per person and day,
 * adapt an existing task instead of creating a new one.
 *
 * OWNER: coldcall implementer (pendenzen implementer may use it read-only).
 *
 * Decisions (documented in ARCHITECTURE «Änderungen»):
 * - An open task of the same company is always adapted (subject, due date, owner) instead of creating a second one.
 *   Among several open tasks the one of the same lead wins, then the most recently created.
 * - The daily limit counts the owner's open tasks due on the same Zurich calendar day. When full, the task moves to the
 *   next working day (Mon–Fri, holidays are not modelled). Tasks never fall on a weekend.
 * - A callback date agreed with the customer («Rückruf vereinbart», `fixedDate`) is never moved; the preview shows a hint
 *   when the day is already full.
 */
import { addDays, addMonths } from 'date-fns';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';
import { RESULT_GROUP_CODES } from './i18n';
import { ZURICH_TZ } from './time';
import type { CrmId, CrmTask, CrmTaskType, IsoDateTime, TaskOp } from './types';

export interface TaskProposal {
  leadId: CrmId;
  subject: string;
  description?: string | null;
  dueAt: IsoDateTime;
  ownerId: CrmId;
  taskType: CrmTaskType;
  /** Date agreed with the customer (callback) – never shifted by the daily limit. */
  fixedDate?: boolean;
}

export interface TaskRuleContext {
  /** Open tasks of the whole company (all leads of the same domain / account). */
  openCompanyTasks: CrmTask[];
  /** Open tasks of the owner (for the per-day limit). */
  ownerOpenTasks: CrmTask[];
  maxPerPersonPerDay: number;
  now: Date;
  timeZone?: string;
}

export interface TaskRuleDecision {
  /** Operation to put into the change set (create, update existing, or null = no task). */
  op: TaskOp | null;
  /** German explanation for the preview, e.g. «bestehende Aufgabe vom 12.11. angepasst». */
  note: string | null;
}

/** Max. days the daily-limit search moves forward before giving up (keeps the loop bounded). */
const MAX_SHIFT_DAYS = 60;

function isWeekendWall(wall: Date): boolean {
  const day = wall.getDay();
  return day === 0 || day === 6;
}

/** Monday–Friday in the given time zone (holidays are not modelled). */
export function isWorkday(date: Date, timeZone: string = ZURICH_TZ): boolean {
  return !isWeekendWall(toZonedTime(date, timeZone));
}

/**
 * Add working days (Mon–Fri) in Europe/Zurich, keeping the local time of day, e.g. «nach 3 Arbeitstagen».
 * `days = 0` returns the date itself, or the next working day if it falls on a weekend.
 */
export function addWorkdays(date: Date, days: number, timeZone: string = ZURICH_TZ): Date {
  let wall = toZonedTime(date, timeZone);
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    wall = addDays(wall, 1);
    if (!isWeekendWall(wall)) remaining--;
  }
  while (isWeekendWall(wall)) wall = addDays(wall, 1);
  return fromZonedTime(wall, timeZone);
}

/** Start of the current half-day (00:00 or 12:00 local). Calls before/after noon are different half-days. */
export function halfDayStart(date: Date, timeZone: string = ZURICH_TZ): Date {
  const wall = toZonedTime(date, timeZone);
  const day = formatInTimeZone(date, timeZone, 'yyyy-MM-dd');
  return fromZonedTime(`${day}T${wall.getHours() < 12 ? '00:00' : '12:00'}:00`, timeZone);
}

/**
 * Next attempt after «Nicht erreicht» – never in the same half-day (INTENT 6.1 Fälligkeit):
 * morning → same day 13:00, afternoon → next working day 08:00 (weekends skipped).
 */
export function nextAttemptAfterNotReached(at: Date, timeZone: string = ZURICH_TZ): Date {
  const wall = toZonedTime(at, timeZone);
  const day = formatInTimeZone(at, timeZone, 'yyyy-MM-dd');
  if (wall.getHours() < 12 && !isWeekendWall(wall)) return fromZonedTime(`${day}T13:00:00`, timeZone);
  const nextDay = addWorkdays(fromZonedTime(`${day}T08:00:00`, timeZone), 1, timeZone);
  return nextDay;
}

function zurichDay(date: Date | string, timeZone: string): string {
  return formatInTimeZone(typeof date === 'string' ? new Date(date) : date, timeZone, 'yyyy-MM-dd');
}

function formatDay(date: Date | string, timeZone: string): string {
  return formatInTimeZone(typeof date === 'string' ? new Date(date) : date, timeZone, 'dd.MM.yyyy');
}

/** Existing open task to adapt: same lead first, then the most recently created one of the company. */
function pickExistingTask(openCompanyTasks: CrmTask[], leadId: CrmId): CrmTask | null {
  const open = openCompanyTasks.filter((t) => t.statecode === 0);
  if (!open.length) return null;
  const sameLead = open.filter((t) => t.leadId === leadId);
  const pool = sameLead.length ? sameLead : open;
  return [...pool].sort((a, b) => b.createdon.localeCompare(a.createdon))[0] ?? null;
}

export function applyTaskRules(proposal: TaskProposal, ctx: TaskRuleContext): TaskRuleDecision {
  const tz = ctx.timeZone ?? ZURICH_TZ;
  const notes: string[] = [];
  const existing = pickExistingTask(ctx.openCompanyTasks, proposal.leadId);

  let due = new Date(proposal.dueAt);
  if (Number.isNaN(due.getTime())) due = ctx.now;

  if (!proposal.fixedDate && !isWorkday(due, tz)) {
    due = addWorkdays(due, 0, tz);
    notes.push(`Wochenende – auf ${formatDay(due, tz)} gelegt`);
  }

  const countOn = (day: string) =>
    ctx.ownerOpenTasks.filter(
      (t) =>
        t.statecode === 0 &&
        t.id !== existing?.id &&
        (t.ownerId == null || t.ownerId === proposal.ownerId) &&
        t.dueAt != null &&
        zurichDay(t.dueAt, tz) === day,
    ).length;

  const max = Math.max(1, ctx.maxPerPersonPerDay);
  if (proposal.fixedDate) {
    const count = countOn(zurichDay(due, tz));
    if (count >= max) notes.push(`vereinbarter Rückruf bleibt, obwohl an diesem Tag schon ${count} Aufgaben anstehen`);
  } else {
    const original = zurichDay(due, tz);
    let shifts = 0;
    while (countOn(zurichDay(due, tz)) >= max && shifts < MAX_SHIFT_DAYS) {
      due = addWorkdays(due, 1, tz);
      shifts++;
    }
    if (shifts > 0 && zurichDay(due, tz) !== original) {
      notes.push(`max. ${max} Aufgaben pro Tag – auf ${formatDay(due, tz)} verschoben`);
    }
  }

  const base = {
    leadId: existing?.leadId ?? proposal.leadId,
    subject: proposal.subject,
    description: proposal.description ?? null,
    dueAt: due.toISOString(),
    ownerId: proposal.ownerId,
    taskType: proposal.taskType,
  };

  if (existing) {
    const parts = [`bestehende Aufgabe vom ${formatDay(existing.createdon, tz)} angepasst (neueste Info gewinnt, keine zweite Aufgabe pro Firma)`];
    if (existing.ownerId && existing.ownerId !== proposal.ownerId) parts.push(`übernimmt die Aufgabe von ${existing.ownerName ?? 'anderer Person'}`);
    const note = [...parts, ...notes].join(' · ');
    return { op: { id: `task-update-${existing.id}`, action: 'update', taskId: existing.id, ...base, ruleNote: note }, note };
  }
  const note = notes.length ? notes.join(' · ') : null;
  return { op: { id: 'task-create-1', action: 'create', taskId: null, ...base, ruleNote: note }, note };
}

/**
 * Earliest date a new attempt is allowed after a result («Kein Bedarf»: frühestens 3 Monate, «Hat Partner»: 6 Monate).
 * null = no waiting period.
 */
export function earliestNewAttempt(lastResultCode: number | null, lastContactAt: IsoDateTime | null): IsoDateTime | null {
  if (lastResultCode == null || !lastContactAt) return null;
  const at = new Date(lastContactAt);
  if (Number.isNaN(at.getTime())) return null;
  if (lastResultCode === RESULT_GROUP_CODES.no_need) return addMonths(at, 3).toISOString();
  if (lastResultCode === RESULT_GROUP_CODES.has_partner) return addMonths(at, 6).toISOString();
  return null;
}
