/**
 * Worker process: runs background jobs from the `jobs` table (Postgres only).
 * With PGlite (local dev without DATABASE_URL) the database is single-process, so the API runs the jobs embedded and
 * this process exits immediately.
 *
 * Health: touches `<tmpdir>/sales-portal-worker.heartbeat` after every polling round (used by the Docker healthcheck).
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigError, loadConfig } from './config';
import { createContext, createJobRunner } from './context';

export const HEARTBEAT_FILE = path.join(tmpdir(), 'sales-portal-worker.heartbeat');

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  if (config.db.kind === 'pglite') {
    console.log('[worker] PGlite mode: jobs run inside the API process – nothing to do here.');
    return;
  }

  const ctx = await createContext(config, { seed: false });
  const runner = createJobRunner(ctx, () => {
    try {
      writeFileSync(HEARTBEAT_FILE, String(Date.now()));
    } catch {
      /* read-only FS without tmpfs – healthcheck will report it */
    }
  });
  runner.start();
  ctx.log.info({ jobTypes: ctx.jobs.types() }, 'Sales-Portal worker ready');

  const shutdown = async (signal: string) => {
    ctx.log.info({ signal }, 'worker shutting down');
    await runner.stop();
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal worker error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
