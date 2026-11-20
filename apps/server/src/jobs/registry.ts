/**
 * Job handler registry. Modules register handlers from their own folder via `defineModule({ jobs(registry) { … } })`.
 *
 *   registry.register('ai.analyze_call', async (payload, ctx) => { … }, { maxAttempts: 3 });
 *   registry.registerRecurring('scheduling.calendar_delta', 3 * 60_000, async (ctx) => { … });
 *
 * Handlers must be idempotent (a job can run more than once after a crash or retry).
 */
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import type { Adapters } from '../integrations';
import type { Logger } from '../lib/logger';
import type { EnqueueOptions } from './queue';

export interface JobContext {
  config: AppConfig;
  db: Db;
  /** System adapters (app registration). */
  adapters: Adapters;
  log: Logger;
  job: { id: number; type: string; attempts: number; maxAttempts: number };
  enqueue(type: string, payload?: Record<string, unknown>, options?: EnqueueOptions): Promise<void>;
  now(): Date;
}

export type JobHandler<P extends Record<string, unknown> = Record<string, unknown>> = (payload: P, ctx: JobContext) => Promise<void>;
export type RecurringHandler = (ctx: Omit<JobContext, 'job'> & { job: JobContext['job'] }) => Promise<void>;

export interface JobOptions {
  maxAttempts?: number;
}

export interface RegisteredJob {
  type: string;
  handler: JobHandler;
  options: JobOptions;
}

export interface RecurringJob {
  name: string;
  everyMs: number;
  handler: RecurringHandler;
}

export class JobRegistry {
  private readonly handlers = new Map<string, RegisteredJob>();
  private readonly recurring = new Map<string, RecurringJob>();

  register<P extends Record<string, unknown>>(type: string, handler: JobHandler<P>, options: JobOptions = {}): void {
    if (this.handlers.has(type)) throw new Error(`Job handler ${type} registered twice`);
    this.handlers.set(type, { type, handler: handler as JobHandler, options });
  }

  /** Runs `handler` roughly every `everyMs` (enqueued as job type `recurring:<name>`, deduplicated). */
  registerRecurring(name: string, everyMs: number, handler: RecurringHandler): void {
    if (this.recurring.has(name)) throw new Error(`Recurring job ${name} registered twice`);
    this.recurring.set(name, { name, everyMs, handler });
    this.register(`recurring:${name}`, async (_payload, ctx) => handler(ctx), { maxAttempts: 1 });
  }

  get(type: string): RegisteredJob | undefined {
    return this.handlers.get(type);
  }

  listRecurring(): RecurringJob[] {
    return [...this.recurring.values()];
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }
}
