/**
 * Push of the ai module's change sets (kind `analysis` and `mail`) through the normal change-set push of the
 * changesets module (re-read → conflict check → CrmAdapter.applyChangeSet → status/results → field-level audit).
 *
 * The ai change sets are stored WITHOUT `callSessionId`: the changesets push updates the call session (status, result
 * group, change set id) for change sets that carry one, which must only happen for the call's own result.
 */
import type { ChangeSet, Conflict } from '@sales-portal/shared';
import type { InferSelectModel } from 'drizzle-orm';
import type { RequestAuth } from '../../auth/rbac';
import { changeSets } from '../../db/schema';
import { pushChangeSet as pushViaChangesets, toChangeSet } from '../changesets/service';
import type { AiDeps } from './common';

export type ChangeSetRow = InferSelectModel<typeof changeSets>;

export function snapshotKeyOf(entity: string, entityId: string, field: string): string {
  return `${entity}:${entityId}:${field}`;
}

export function rowToChangeSet(r: ChangeSetRow): ChangeSet {
  return toChangeSet(r);
}

export type PushOutcome =
  | { status: 'pushed'; changeSet: ChangeSet }
  | { status: 'conflict'; changeSet: ChangeSet; conflicts: Conflict[] }
  | { status: 'failed'; changeSet: ChangeSet; error: string };

/**
 * Push a stored change set as the given user. Conflicts need a resolution per op (`overwrite` / `keep_crm`);
 * unresolved conflicts stop the push (status `conflict`). Nothing is overwritten silently.
 */
export async function pushChangeSet(
  deps: AiDeps,
  row: ChangeSetRow,
  auth: RequestAuth,
  resolutions: Record<string, 'overwrite' | 'keep_crm'> = {},
): Promise<PushOutcome> {
  let res: Awaited<ReturnType<typeof pushViaChangesets>>;
  try {
    res = await pushViaChangesets({ db: deps.db, crm: deps.adapters.crm, auth, now: deps.now }, row.id, resolutions);
  } catch (err) {
    deps.log.warn({ changeSetId: row.id, err: { message: err instanceof Error ? err.message : String(err) } }, 'ai change set push failed');
    throw err;
  }
  if (res.status === 'pushed') return { status: 'pushed', changeSet: res.changeSet };
  if (res.status === 'conflict') return { status: 'conflict', changeSet: res.changeSet, conflicts: res.changeSet.conflicts.filter((c) => !c.resolution) };
  return { status: 'failed', changeSet: res.changeSet, error: res.changeSet.error ?? 'Speichern im CRM fehlgeschlagen' };
}
