/** Active result-group rules (versioned in `result_group_rules`, defaults from INTENT 6.5). */
import { DEFAULT_RESULT_GROUP_RULES, type ResultGroupKey, type ResultGroupRule } from '@sales-portal/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { resultGroupRules } from '../../db/schema';

/** Newest active version per key, sorted for the wrap-up panel. Falls back to the defaults if the table is empty. */
export async function loadActiveRules(db: Db): Promise<ResultGroupRule[]> {
  const rows = await db.select().from(resultGroupRules).where(eq(resultGroupRules.isActive, true));
  const byKey = new Map<string, { version: number; rule: ResultGroupRule; sortOrder: number }>();
  for (const r of rows) {
    const prev = byKey.get(r.key);
    if (!prev || r.version > prev.version) {
      byKey.set(r.key, { version: r.version, rule: { ...r.definition, key: r.key as ResultGroupKey, version: r.version }, sortOrder: r.sortOrder });
    }
  }
  const rules = byKey.size ? [...byKey.values()].map((x) => x.rule) : DEFAULT_RESULT_GROUP_RULES;
  return rules.filter((r) => r.active !== false).sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function getActiveRule(db: Db, key: ResultGroupKey): Promise<ResultGroupRule | null> {
  return (await loadActiveRules(db)).find((r) => r.key === key) ?? null;
}
