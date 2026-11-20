/**
 * Delta sync helper for the scheduling jobs (INTENT 6.11): keeps the Graph deltaLink per mailbox in `sync_state`
 * (key `calendar.delta:<mailbox>`). Works with the mock and the live calendar adapter.
 *
 * - The token is only stored after a successful delta call (a failed run repeats the same window next time).
 * - The delta window is fixed when the sync starts; after `maxTokenAgeDays` the sync restarts so the window
 *   moves with time (the caller must treat the result of a reset as a full snapshot: `reset: true`).
 */
import type { CalendarDelta } from '@sales-portal/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { syncState } from '../../db/schema';
import type { CalendarAdapter } from '../calendar/types';

/** Same key and a superset of the shape the scheduling job uses (`{ token, polledAt }`), so both can share it. */
export interface StoredDeltaToken {
  token: string;
  /** Last successful sync (ISO). */
  polledAt: string;
  /** When the current delta window was started (ISO). */
  startedAt: string;
}

export const deltaKey = (mailbox: string) => `calendar.delta:${mailbox.trim().toLowerCase()}`;

export async function loadDeltaToken(db: Db, mailbox: string): Promise<StoredDeltaToken | null> {
  const [row] = await db.select().from(syncState).where(eq(syncState.key, deltaKey(mailbox)));
  const v = row?.value as Partial<StoredDeltaToken> | undefined;
  if (!v || typeof v.token !== 'string') return null;
  const polledAt = typeof v.polledAt === 'string' ? v.polledAt : (row?.updatedAt ?? new Date()).toISOString();
  return { token: v.token, polledAt, startedAt: typeof v.startedAt === 'string' ? v.startedAt : polledAt };
}

export async function saveDeltaToken(db: Db, mailbox: string, value: StoredDeltaToken): Promise<void> {
  await db
    .insert(syncState)
    .values({ key: deltaKey(mailbox), value })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt: new Date() } });
}

export async function clearDeltaToken(db: Db, mailbox: string): Promise<void> {
  await db.delete(syncState).where(eq(syncState.key, deltaKey(mailbox)));
}

/** One delta round for `mailbox` with the stored token; stores the next token. */
export async function syncCalendarDelta(
  db: Db,
  calendar: CalendarAdapter,
  mailbox: string,
  options: { now?: Date; maxTokenAgeDays?: number } = {},
): Promise<CalendarDelta & { reset: boolean }> {
  const now = options.now ?? new Date();
  const maxAgeMs = (options.maxTokenAgeDays ?? 7) * 86_400_000;
  const stored = await loadDeltaToken(db, mailbox);
  const expired = !!stored && now.getTime() - Date.parse(stored.startedAt) > maxAgeMs;
  const token = stored && !expired ? stored.token : null;
  const result = await calendar.delta(mailbox, token);
  await saveDeltaToken(db, mailbox, {
    token: result.nextToken,
    polledAt: now.toISOString(),
    startedAt: token && stored ? stored.startedAt : now.toISOString(),
  });
  return { ...result, reset: token === null };
}
