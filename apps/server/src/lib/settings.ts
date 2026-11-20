/** Typed access to the `settings` table (admin-editable values, INTENT 6.14). */
import type { Actor, SettingKey, SettingsMap } from '@sales-portal/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { DEFAULT_SETTINGS } from '../db/seed/defaults';
import { settings } from '../db/schema';
import { audit } from './audit';

export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<SettingsMap[K]> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return (row?.value as SettingsMap[K] | undefined) ?? DEFAULT_SETTINGS[key];
}

export async function getAllSettings(db: Db): Promise<SettingsMap> {
  const rows = await db.select().from(settings);
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const r of rows) out[r.key] = r.value;
  return out as unknown as SettingsMap;
}

/** Update a setting and write the audit log (admin action). */
export async function setSetting<K extends SettingKey>(db: Db, key: K, value: SettingsMap[K], actor: Actor): Promise<void> {
  const old = await getSetting(db, key);
  await db
    .insert(settings)
    .values({ key, value: value as unknown, updatedBy: actor.userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: value as unknown, updatedBy: actor.userId, updatedAt: new Date() } });
  await audit(db, { actor, action: 'admin.setting_update', entity: 'setting', entityId: key, oldValue: old, newValue: value });
}
