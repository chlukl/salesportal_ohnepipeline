/** Shared plumbing of the scheduling module: dependencies for routes and jobs, task rules with fallback. */
import { addWorkingDays, applyTaskRules, type CrmTask, type TaskOp } from '@sales-portal/shared';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { Db } from '../../db/client';
import { adaptersFor, type Adapters } from '../../integrations';
import type { CalendarAdapter } from '../../integrations/calendar';
import { enqueueJob, type EnqueueOptions } from '../../jobs/queue';
import type { JobContext } from '../../jobs/registry';
import { aiDepsFor, aiDepsFromJob, deleteBriefingForBooking, onBookingCreated, updateBriefingForBooking, type AiDeps } from '../ai/service';

/**
 * Hooks into the ai module's briefing (INTENT 6.10): build after booking, refresh after a move, remove after a cancellation.
 * Optional so tests and callers without briefing (e.g. proposals for the use-case mail) can leave them out. Never throw:
 * the ai module's 5-minute sweep catches anything missed.
 */
export interface BriefingHooks {
  created(bookingId: string): Promise<void>;
  updated(bookingId: string): Promise<void>;
  deleted(bookingId: string): Promise<void>;
}

export function briefingHooks(ai: AiDeps): BriefingHooks {
  const safe = (what: string, fn: (deps: AiDeps, id: string) => Promise<void>) => async (bookingId: string) => {
    try {
      await fn(ai, bookingId);
    } catch (err) {
      ai.log.warn({ err: { message: err instanceof Error ? err.message : String(err) }, bookingId }, `briefing hook ${what} failed – sweep will retry`);
    }
  };
  return { created: safe('created', onBookingCreated), updated: safe('updated', updateBriefingForBooking), deleted: safe('deleted', deleteBriefingForBooking) };
}

export interface SchedulingDeps {
  db: Db;
  /** Adapters acting for the user (CRM reads, mail from the own mailbox). In jobs: system adapters. */
  adapters: Adapters;
  /** Delegated calendar access (meeting in the sales' calendar via Markus' delegation). */
  calendar: CalendarAdapter;
  /** App registration: blockers, briefing entries, delta queries (background tasks, INTENT 8). */
  systemCalendar: CalendarAdapter;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  now(): Date;
  enqueue(type: string, payload?: Record<string, unknown>, options?: EnqueueOptions): Promise<void>;
  /** Briefing hooks of the ai module (optional). */
  briefing?: BriefingHooks;
  /**
   * Cross-process lock around check-then-create of bookings (Postgres advisory lock; no-op on PGlite). The in-process
   * mutex in `withBookingLock` is always applied on top.
   */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** Advisory lock id for «check free/busy → create/move meeting» (double-booking guard, INTENT 6.6). */
export const BOOKING_LOCK_ID = 727_106;

let bookingChain: Promise<unknown> = Promise.resolve();

/**
 * Serializes booking creation and moves: within the process (promise chain) and across processes (`deps.lock`).
 * Bookings are rare (a few per day), so one global lock is enough and keeps every attendee combination covered.
 */
export function withBookingLock<T>(deps: Pick<SchedulingDeps, 'lock'>, fn: () => Promise<T>): Promise<T> {
  const run = () => (deps.lock ? deps.lock(fn) : fn());
  const next = bookingChain.then(run, run);
  bookingChain = next.catch(() => undefined);
  return next;
}

export function depsFromRequest(request: FastifyRequest): SchedulingDeps {
  const server = request.server;
  const adapters = adaptersFor(request);
  return {
    db: server.db,
    adapters,
    calendar: adapters.calendar,
    systemCalendar: server.adapters.system().calendar,
    log: request.log,
    now: server.ctx.now,
    enqueue: (type, payload = {}, options = {}) => enqueueJob(server.db, type, payload, options),
    briefing: briefingHooks(aiDepsFor(request)),
    lock: (fn) => server.ctx.dbHandle.withAdvisoryLock(BOOKING_LOCK_ID, fn),
  };
}

export function depsFromJob(ctx: Pick<JobContext, 'config' | 'db' | 'adapters' | 'log' | 'now' | 'enqueue'>): SchedulingDeps {
  return {
    db: ctx.db,
    adapters: ctx.adapters,
    calendar: ctx.adapters.calendar,
    systemCalendar: ctx.adapters.calendar,
    log: ctx.log,
    now: () => ctx.now(),
    enqueue: (type, payload = {}, options = {}) => ctx.enqueue(type, payload, options),
    briefing: briefingHooks(aiDepsFromJob(ctx)),
  };
}

export function addMinutesIso(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

/**
 * Follow-up task through REGEL_AUFGABEN (taskRules.ts, owned by the coldcall module). While that engine is not available
 * the task is proposed as a plain «create» – the approval preview still shows it.
 */
export function applyTaskRulesSafe(
  proposal: { leadId: string; subject: string; dueAt: string; ownerId: string; taskType: CrmTask['taskType']; description?: string | null },
  ctx: { openCompanyTasks: CrmTask[]; ownerOpenTasks: CrmTask[]; maxPerPersonPerDay: number; now: Date },
): { op: TaskOp | null; note: string | null } {
  try {
    return applyTaskRules(proposal, ctx);
  } catch {
    return {
      op: {
        id: 'proposals-task-1',
        action: 'create',
        leadId: proposal.leadId,
        subject: proposal.subject,
        description: proposal.description ?? null,
        dueAt: proposal.dueAt,
        ownerId: proposal.ownerId,
        taskType: proposal.taskType,
        ruleNote: null,
      },
      note: null,
    };
  }
}

export { addWorkingDays };
