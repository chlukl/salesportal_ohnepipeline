/**
 * Admin settings that are not part of the shared `SettingsMap` (kept in the same `settings` table, own keys, own zod
 * validation). Used by the admin module (editor) and the dashboard (weekly report).
 */
import type { Actor, IsoDate } from '@sales-portal/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { settings } from '../../db/schema';
import { audit } from '../../lib/audit';

export const email = z.string().trim().toLowerCase().email('ungültige E-Mail-Adresse').max(200);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');

export const SECRET_NAMES = ['entra_client_secret', 'entra_certificate', 'anthropic_api_key', 'vera_api_key'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const EXTRA_SCHEMAS = {
  'weeklyReport.recipient': email.nullable(),
  /** Mailbox the report is sent from (app registration); null = recipient mailbox. */
  'weeklyReport.sender': email.nullable(),
  /** Admin-entered expiry dates of secrets / certificates (INTENT 6.14, risk «abgelaufene Geheimnisse»). */
  'secrets.expiry': z.partialRecord(z.enum(SECRET_NAMES), isoDate.nullable()),
} as const;

export type ExtraSettingKey = keyof typeof EXTRA_SCHEMAS;
export type ExtraSettings = { [K in ExtraSettingKey]: z.infer<(typeof EXTRA_SCHEMAS)[K]> };

export const EXTRA_DEFAULTS: ExtraSettings = {
  'weeklyReport.recipient': null,
  'weeklyReport.sender': null,
  'secrets.expiry': {} as Partial<Record<SecretName, IsoDate | null>>,
};

export async function getExtraSetting<K extends ExtraSettingKey>(db: Db, key: K): Promise<ExtraSettings[K]> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  if (!row) return EXTRA_DEFAULTS[key];
  const parsed = EXTRA_SCHEMAS[key].safeParse(row.value);
  return parsed.success ? (parsed.data as ExtraSettings[K]) : EXTRA_DEFAULTS[key];
}

/** Validates, stores and audits (admin action). */
export async function setExtraSetting<K extends ExtraSettingKey>(db: Db, key: K, value: ExtraSettings[K], actor: Actor): Promise<void> {
  const parsed = EXTRA_SCHEMAS[key].parse(value) as ExtraSettings[K];
  const old = await getExtraSetting(db, key);
  await db
    .insert(settings)
    .values({ key, value: parsed as unknown, updatedBy: actor.userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: parsed as unknown, updatedBy: actor.userId, updatedAt: new Date() } });
  await audit(db, { actor, action: 'admin.setting_update', entity: 'setting', entityId: key, oldValue: old, newValue: parsed });
}
