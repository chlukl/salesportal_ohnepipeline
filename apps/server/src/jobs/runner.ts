/**
 * DB-backed job runner (ARCHITECTURE §2 Worker): claim with `FOR UPDATE SKIP LOCKED`, retry with exponential backoff,
 * stale-lock recovery, recurring jobs. Runs in `worker.ts` (Postgres) or embedded in the API process (PGlite).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import type { Adapters } from '../integrations';
import { safeErrorMessage, type Logger } from '../lib/logger';
import { enqueueJob } from './queue';
import type { JobContext, JobRegistry } from './registry';

interface ClaimedJob {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

const STALE_LOCK_MINUTES = 15;
const MAX_BACKOFF_MS = 60 * 60_000;

export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export interface JobRunnerOptions {
  config: AppConfig;
  db: Db;
  adapters: Adapters;
  log: Logger;
  registry: JobRegistry;
  pollMs?: number;
  concurrency?: number;
  now?: () => Date;
}

export class JobRunner {
  private readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | null = null;
  private running = 0;
  private stopped = true;
  private tickInProgress = false;
  private readonly nextRecurring = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly opts: JobRunnerOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const t = this.now().getTime();
    // First run of recurring jobs shortly after start (spread a little).
    for (const r of this.opts.registry.listRecurring()) this.nextRecurring.set(r.name, t + 5_000 + Math.floor(Math.random() * 10_000));
    this.opts.log.info({ workerId: this.workerId, types: this.opts.registry.types().length }, 'job runner started');
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const deadline = Date.now() + 10_000;
    while (this.running > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(this.opts.pollMs ?? 2000));
    }, ms);
    this.timer.unref?.();
  }

  /** One polling round (exposed for tests). */
  async tick(): Promise<number> {
    if (this.tickInProgress) return 0;
    this.tickInProgress = true;
    try {
      await this.enqueueDueRecurring();
      await this.recoverStaleLocks();
      const free = (this.opts.concurrency ?? 4) - this.running;
      if (free <= 0) return 0;
      const claimed = await this.claim(free);
      await Promise.all(claimed.map((job) => this.execute(job)));
      return claimed.length;
    } catch (err) {
      this.opts.log.error({ err }, 'job runner tick failed');
      return 0;
    } finally {
      this.tickInProgress = false;
    }
  }

  private async enqueueDueRecurring(): Promise<void> {
    const t = this.now().getTime();
    for (const r of this.opts.registry.listRecurring()) {
      const due = this.nextRecurring.get(r.name) ?? t;
      if (t < due) continue;
      this.nextRecurring.set(r.name, t + r.everyMs);
      await enqueueJob(this.opts.db, `recurring:${r.name}`, {}, { dedupeKey: `recurring:${r.name}`, maxAttempts: 1 });
    }
  }

  private async recoverStaleLocks(): Promise<void> {
    await this.opts.db.execute(sql`
      update jobs set status = 'queued', locked_at = null, locked_by = null, updated_at = now()
      where status = 'running' and locked_at < now() - interval '${sql.raw(String(STALE_LOCK_MINUTES))} minutes'
    `);
  }

  private async claim(limit: number): Promise<ClaimedJob[]> {
    const result = await this.opts.db.execute(sql`
      update jobs
         set status = 'running', locked_at = now(), locked_by = ${this.workerId}, attempts = attempts + 1, updated_at = now()
       where id in (
         select id from jobs
          where status = 'queued' and run_at <= now()
          order by run_at, id
          limit ${limit}
          for update skip locked
       )
      returning id, type, payload, attempts, max_attempts
    `);
    return rowsOf<ClaimedJob>(result).map((r) => ({ ...r, id: Number(r.id) }));
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const registered = this.opts.registry.get(job.type);
    const log = this.opts.log.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    this.running += 1;
    try {
      if (!registered) throw new Error(`No handler registered for job type ${job.type}`);
      const ctx: JobContext = {
        config: this.opts.config,
        db: this.opts.db,
        adapters: this.opts.adapters,
        log,
        job: { id: job.id, type: job.type, attempts: job.attempts, maxAttempts: job.max_attempts },
        enqueue: (type, payload, options) => enqueueJob(this.opts.db, type, payload, options),
        now: this.now,
      };
      await registered.handler(job.payload ?? {}, ctx);
      await this.opts.db.execute(sql`
        update jobs set status = 'done', finished_at = now(), updated_at = now(), locked_at = null, locked_by = null, last_error = null
        where id = ${job.id}
      `);
    } catch (err) {
      // Never the raw message: a failed DB query carries all bound values (personal data) → shown in Admin › Fehler.
      const message = safeErrorMessage(err).slice(0, 500);
      const maxAttempts = registered?.options.maxAttempts ?? job.max_attempts;
      if (job.attempts >= maxAttempts) {
        log.error({ err }, 'job failed permanently');
        await this.opts.db.execute(sql`
          update jobs set status = 'dead', last_error = ${message}, finished_at = now(), updated_at = now(), locked_at = null, locked_by = null
          where id = ${job.id}
        `);
      } else {
        const runAt = new Date(this.now().getTime() + backoffMs(job.attempts));
        log.warn({ err: { message }, retryAt: runAt.toISOString() }, 'job failed, will retry');
        await this.opts.db.execute(sql`
          update jobs set status = 'queued', last_error = ${message}, run_at = ${runAt.toISOString()}::timestamptz,
                 updated_at = now(), locked_at = null, locked_by = null
          where id = ${job.id}
        `);
      }
    } finally {
      this.running -= 1;
    }
  }
}
