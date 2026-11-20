/** Enqueue jobs into the `jobs` table (usable from routes and handlers). */
import type { Db, Tx } from '../db/client';
import { jobs } from '../db/schema';

export interface EnqueueOptions {
  /** Earliest execution time (default now). */
  runAt?: Date;
  /** Skip if a queued/running job with the same key exists (e.g. `analysis:<callSessionId>`). */
  dedupeKey?: string;
  maxAttempts?: number;
}

export async function enqueueJob(
  db: Db | Tx,
  type: string,
  payload: Record<string, unknown> = {},
  options: EnqueueOptions = {},
): Promise<void> {
  await db
    .insert(jobs)
    .values({
      type,
      payload,
      runAt: options.runAt ?? new Date(),
      dedupeKey: options.dedupeKey ?? null,
      maxAttempts: options.maxAttempts ?? 5,
    })
    .onConflictDoNothing();
}
