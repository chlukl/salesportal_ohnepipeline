import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobs } from '../src/db/schema';
import { enqueueJob } from '../src/jobs/queue';
import { JobRegistry } from '../src/jobs/registry';
import { backoffMs, JobRunner } from '../src/jobs/runner';
import { createLogger } from '../src/lib/logger';
import { createTestApp, type TestApp } from './helpers';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t?.close();
});

function runnerWith(registry: JobRegistry) {
  return new JobRunner({
    config: t.ctx.config,
    db: t.ctx.db,
    adapters: t.ctx.adapters.system(),
    log: createLogger('silent'),
    registry,
    concurrency: 2,
  });
}

describe('job runner', () => {
  it('runs a queued job and marks it done', async () => {
    const registry = new JobRegistry();
    const seen: unknown[] = [];
    registry.register('test.ok', async (payload) => {
      seen.push(payload);
    });
    await enqueueJob(t.ctx.db, 'test.ok', { n: 1 });
    expect(await runnerWith(registry).tick()).toBe(1);
    expect(seen).toEqual([{ n: 1 }]);
    const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.type, 'test.ok'));
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(1);
  });

  it('retries with backoff and gives up after maxAttempts', async () => {
    const registry = new JobRegistry();
    registry.register('test.fail', async () => {
      throw new Error('boom');
    });
    await enqueueJob(t.ctx.db, 'test.fail', {}, { maxAttempts: 2 });
    const runner = runnerWith(registry);
    await runner.tick();
    let [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.type, 'test.fail'));
    expect(row.status).toBe('queued');
    expect(row.lastError).toBe('boom');
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000);

    // Make it due again → second (last) attempt → dead.
    await t.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, row.id));
    await runner.tick();
    [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.type, 'test.fail'));
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(2);
  });

  it('deduplicates queued jobs by key', async () => {
    await enqueueJob(t.ctx.db, 'test.dedupe', {}, { dedupeKey: 'k1' });
    await enqueueJob(t.ctx.db, 'test.dedupe', {}, { dedupeKey: 'k1' });
    const rows = await t.ctx.db.select().from(jobs).where(eq(jobs.type, 'test.dedupe'));
    expect(rows).toHaveLength(1);
  });

  it('backoff grows exponentially with a cap', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(20)).toBe(3_600_000);
  });

  it('core jobs are registered (sessions, jobs cleanup, transcript retention)', () => {
    expect(t.ctx.jobs.types()).toEqual(
      expect.arrayContaining(['recurring:core.sessions_cleanup', 'recurring:core.jobs_cleanup', 'recurring:core.transcripts_retention']),
    );
  });
});
