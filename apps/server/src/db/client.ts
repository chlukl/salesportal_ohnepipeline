/**
 * Database client: Postgres (`pg`) when DATABASE_URL is set, otherwise PGlite (embedded, single-process).
 * Both expose the same drizzle API (`Db`). Migrations from `./migrations` are applied at startup.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import type { AppConfig } from '../config';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
/** Transaction handle – same API as Db. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  kind: 'pg' | 'pglite';
  close(): Promise<void>;
  /** Run `fn` while holding a Postgres session-level advisory lock (no-op wrapper on PGlite). */
  withAdvisoryLock<T>(lockId: number, fn: () => Promise<T>): Promise<T>;
}

const MIGRATIONS_LOCK_ID = 727_001;

/** Directory with drizzle-kit SQL migrations (src/db/migrations in dev, dist/db/migrations in the build). */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'migrations'), path.join(here, 'db', 'migrations')];
  const found = candidates.find((c) => existsSync(path.join(c, 'meta', '_journal.json')));
  if (!found) throw new Error(`Migrations folder not found (looked in ${candidates.join(', ')})`);
  return found;
}

export async function createDb(dbConfig: AppConfig['db']): Promise<DbHandle> {
  if (dbConfig.kind === 'pg') {
    const pool = new pg.Pool({
      connectionString: dbConfig.url,
      ssl: dbConfig.ssl ? { rejectUnauthorized: true } : undefined,
      max: 10,
    });
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    return {
      db,
      kind: 'pg',
      close: () => pool.end(),
      async withAdvisoryLock(lockId, fn) {
        // Session-level lock: lock and unlock must use the same connection.
        const conn = await pool.connect();
        try {
          await conn.query('select pg_advisory_lock($1)', [lockId]);
          try {
            return await fn();
          } finally {
            await conn.query('select pg_advisory_unlock($1)', [lockId]);
          }
        } finally {
          conn.release();
        }
      },
    };
  }
  const dataDir = dbConfig.dataDir;
  if (!dataDir.startsWith('memory://')) mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  await client.waitReady;
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return { db, kind: 'pglite', close: () => client.close(), withAdvisoryLock: (_id, fn) => fn() };
}

/** Apply pending migrations. On Postgres guarded by an advisory lock (API and worker may start together). */
export async function runMigrations(handle: DbHandle): Promise<void> {
  const migrationsDir = migrationsFolder();
  if (handle.kind === 'pglite') {
    await migratePglite(handle.db as never, { migrationsFolder: migrationsDir });
    return;
  }
  await handle.withAdvisoryLock(MIGRATIONS_LOCK_ID, () => migratePg(handle.db as never, { migrationsFolder: migrationsDir }));
}
