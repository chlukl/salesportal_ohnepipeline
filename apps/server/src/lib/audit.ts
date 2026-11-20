/**
 * Audit log (ARCHITECTURE §5.8): every CRM change and every admin action → `audit_log`
 * (who, when, entity, field, old, new, change set id).
 */
import type { Actor } from '@sales-portal/shared';
import type { Db, Tx } from '../db/client';
import { auditLog } from '../db/schema';

export interface AuditInput {
  actor: Pick<Actor, 'userId' | 'displayName'> | 'system';
  /** e.g. `crm.field_update`, `crm.note_create`, `admin.role_grant`, `auth.login`, `me.view_as`. */
  action: string;
  entity: string;
  entityId?: string | null;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  changeSetId?: string | null;
  meta?: Record<string, unknown> | null;
}

function toRow(e: AuditInput) {
  const actorUserId = e.actor === 'system' ? null : e.actor.userId;
  const actorLabel = e.actor === 'system' ? 'system' : e.actor.displayName;
  return {
    actorUserId,
    actorLabel,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId ?? null,
    field: e.field ?? null,
    oldValue: e.oldValue === undefined ? null : (e.oldValue as never),
    newValue: e.newValue === undefined ? null : (e.newValue as never),
    changeSetId: e.changeSetId ?? null,
    meta: e.meta ?? null,
  };
}

/** Write one audit entry (inside a transaction if `db` is a Tx). */
export async function audit(db: Db | Tx, entry: AuditInput): Promise<void> {
  await db.insert(auditLog).values(toRow(entry));
}

/** Write several entries at once (e.g. one per field of a pushed change set). */
export async function auditMany(db: Db | Tx, entries: AuditInput[]): Promise<void> {
  if (entries.length === 0) return;
  await db.insert(auditLog).values(entries.map(toRow));
}
