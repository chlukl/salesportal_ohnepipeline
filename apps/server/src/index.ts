/** API process: HTTP server (+ embedded job runner when PGlite is used or WORKER_EMBEDDED=true). */
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { createContext, createJobRunner } from './context';

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

  const ctx = await createContext(config);
  const app = await buildApp(ctx);
  await app.listen({ host: config.host, port: config.port });
  ctx.log.info(
    { env: config.nodeEnv, auth: config.auth.mode, integrations: config.integrationsMode, db: config.db.kind, label: config.environmentLabel },
    'Sales-Portal API ready',
  );

  const runner = config.worker.embedded ? createJobRunner(ctx) : null;
  if (runner) {
    runner.start();
    ctx.log.info(config.db.kind === 'pglite' ? 'job runner embedded (PGlite is single-process)' : 'job runner embedded');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.log.info({ signal }, 'shutting down');
    try {
      await runner?.stop();
      await app.close();
      await ctx.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
