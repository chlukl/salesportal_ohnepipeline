/**
 * Seeding entry point (idempotent, runs at startup):
 * - defaults (rules, templates, objections, settings) always, only where missing
 * - demo users when AUTH_MODE=dev or the CRM is mock
 * - demo CRM data when the CRM adapter is mock and SEED_DEMO_DATA is on
 */
import { inArray } from 'drizzle-orm';
import type { AppConfig } from '../../config';
import type { Db } from '../client';
import { userRoles, users } from '../schema';
import { seedDefaults } from './defaults';
import { seedDemo } from './demo';
import { DEMO_USERS } from './users';

export async function seedDemoUsers(db: Db): Promise<void> {
  await db
    .insert(users)
    .values(
      DEMO_USERS.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        crmUserId: u.crmUserId,
        phoneE164: u.phoneE164,
      })),
    )
    .onConflictDoNothing();
  // Only grant roles to demo users that have none yet (admin changes win).
  const existing = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(inArray(userRoles.userId, DEMO_USERS.map((u) => u.id)));
  const withRoles = new Set(existing.map((r) => r.userId));
  const rows = DEMO_USERS.filter((u) => !withRoles.has(u.id)).flatMap((u) => u.roles.map((role) => ({ userId: u.id, role })));
  if (rows.length) await db.insert(userRoles).values(rows).onConflictDoNothing();
}

export interface SeedOptions {
  /** Override "now" (tests). */
  now?: Date;
  /** Skip the ~400-lead demo CRM (tests that only need users). */
  skipDemoCrm?: boolean;
}

export async function runSeeds(db: Db, config: AppConfig, options: SeedOptions = {}): Promise<{ demo: Record<string, number> | null }> {
  await seedDefaults(db);
  if (config.auth.mode === 'dev' || config.adapters.crm === 'mock') await seedDemoUsers(db);
  if (config.seedDemoData && !options.skipDemoCrm) {
    const result = await seedDemo(db, { now: options.now });
    return { demo: result.seeded ? result.counts : null };
  }
  return { demo: null };
}
