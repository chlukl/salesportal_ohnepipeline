/** Application context shared by the API process, the worker and tests. */
import type { AppConfig } from './config';
import { createDb, runMigrations, type Db, type DbHandle } from './db/client';
import { runSeeds, type SeedOptions } from './db/seed';
import { createAdapterFactory, type AdapterFactory } from './integrations';
import { registerCoreJobs } from './jobs/core';
import { JobRegistry } from './jobs/registry';
import { JobRunner } from './jobs/runner';
import { createLogger, type Logger } from './lib/logger';
import { MODULES } from './modules';
import { collectCounters, registerModuleJobs, type CounterRegistry, type PortalModule } from './modules/registry';

export interface AppContext {
  config: AppConfig;
  db: Db;
  dbHandle: DbHandle;
  log: Logger;
  adapters: AdapterFactory;
  modules: PortalModule[];
  counters: CounterRegistry;
  jobs: JobRegistry;
  now: () => Date;
  close(): Promise<void>;
}

export interface CreateContextOptions {
  log?: Logger;
  /** false = no seeding (worker); object = seed options (tests). */
  seed?: SeedOptions | false;
  now?: () => Date;
  /** Override the module list (tests). */
  modules?: PortalModule[];
}

export async function createContext(config: AppConfig, options: CreateContextOptions = {}): Promise<AppContext> {
  const log = options.log ?? createLogger(config.logLevel, config.nodeEnv === 'development');
  const dbHandle = await createDb(config.db);
  await runMigrations(dbHandle);
  if (options.seed !== false) {
    const result = await runSeeds(dbHandle.db, config, options.seed ?? {});
    if (result.demo) log.info({ demo: result.demo }, 'demo data seeded');
  }
  const now = options.now ?? (() => new Date());
  const modules = options.modules ?? MODULES;
  const jobs = new JobRegistry();
  registerCoreJobs(jobs);
  registerModuleJobs(modules, jobs);
  return {
    config,
    db: dbHandle.db,
    dbHandle,
    log,
    adapters: createAdapterFactory({ config, db: dbHandle.db, log, now }),
    modules,
    counters: collectCounters(modules),
    jobs,
    now,
    close: () => dbHandle.close(),
  };
}

export function createJobRunner(ctx: AppContext, onTick?: () => void): JobRunner {
  const runner = new JobRunner({
    config: ctx.config,
    db: ctx.db,
    adapters: ctx.adapters.system(),
    log: ctx.log.child({ component: 'worker' }),
    registry: ctx.jobs,
    pollMs: ctx.config.worker.pollMs,
    concurrency: ctx.config.worker.concurrency,
    now: ctx.now,
  });
  if (onTick) {
    const original = runner.tick.bind(runner);
    runner.tick = async () => {
      const n = await original();
      onTick();
      return n;
    };
  }
  return runner;
}
