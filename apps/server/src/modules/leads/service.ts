/**
 * Leads service (OWNER: coldcall implementer): call list with the call-list defaults (INTENT 6.1, 5),
 * «nächster Lead», saved filters per person (`saved_filters`, scope 'leads').
 */
import type { Lead, LeadQuery, Paged, SavedFilter } from '@sales-portal/shared';
import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { savedFilters } from '../../db/schema';
import type { Adapters } from '../../integrations';
import { badRequest, notFound } from '../../lib/errors';

export const MAX_SAVED_FILTERS = 50;

/**
 * Call-list defaults: only leads with a valid number («Erreichbarkeit», otherwise «Nummer prüfen»), no retry in the
 * same half-day after «Nicht erreicht», locked campaign leads hidden (adapter default). Explicit `false` lifts a default.
 */
export function withCallListDefaults(query: LeadQuery): LeadQuery {
  // Admin «alles zeigen» (includeHidden): no call-list defaults.
  if (query.includeHidden) return query;
  return {
    ...query,
    requirePhone: query.requirePhone ?? true,
    hideRetryPending: query.hideRetryPending ?? true,
    campaign: query.campaign ?? 'exclude_locked',
  };
}

export async function listLeads(adapters: Adapters, query: LeadQuery): Promise<Paged<Lead>> {
  return adapters.crm.listLeads(withCallListDefaults(query));
}

/** Next lead of the user's list after the current one (skipping leads already worked in this session). */
export async function nextLead(adapters: Adapters, query: LeadQuery, currentLeadId: string | undefined, skip: string[]): Promise<Lead | null> {
  const exclude = [...new Set([...(currentLeadId ? [currentLeadId] : []), ...skip])].slice(0, 500);
  const page = await adapters.crm.listLeads(withCallListDefaults({ ...query, excludeLeadIds: exclude, page: 1, pageSize: 1 }));
  return page.items[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Saved filters (per person)
// ---------------------------------------------------------------------------------------------------------------------

type Row = typeof savedFilters.$inferSelect;

export interface SavedLeadFilter extends SavedFilter<LeadQuery> {
  sort: { key: string; direction: 'asc' | 'desc' } | null;
}

function toSaved(r: Row): SavedLeadFilter {
  return {
    id: r.id,
    scope: r.scope,
    name: r.name,
    filter: r.filter as LeadQuery,
    columns: r.columns ?? null,
    sort: r.sort ?? null,
    isDefault: r.isDefault,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export interface SavedFilterInput {
  name: string;
  filter: LeadQuery;
  columns?: string[] | null;
  sort?: { key: string; direction: 'asc' | 'desc' } | null;
  isDefault?: boolean;
}

/** Strip paging and session-only values before storing a filter. */
function storable(filter: LeadQuery): Record<string, unknown> {
  const { page: _p, pageSize: _s, excludeLeadIds: _e, ...rest } = filter;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));
}

export async function listSavedFilters(db: Db, userId: string): Promise<SavedLeadFilter[]> {
  const rows = await db
    .select()
    .from(savedFilters)
    .where(and(eq(savedFilters.userId, userId), eq(savedFilters.scope, 'leads')))
    .orderBy(asc(savedFilters.name));
  return rows.map(toSaved);
}

async function clearDefault(db: Db, userId: string, exceptId?: string): Promise<void> {
  const where = exceptId
    ? and(eq(savedFilters.userId, userId), eq(savedFilters.scope, 'leads'), ne(savedFilters.id, exceptId))
    : and(eq(savedFilters.userId, userId), eq(savedFilters.scope, 'leads'));
  await db.update(savedFilters).set({ isDefault: false }).where(where);
}

export async function createSavedFilter(db: Db, userId: string, input: SavedFilterInput, now: Date): Promise<SavedLeadFilter> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(savedFilters)
    .where(and(eq(savedFilters.userId, userId), eq(savedFilters.scope, 'leads')));
  if (n >= MAX_SAVED_FILTERS) throw badRequest(`Höchstens ${MAX_SAVED_FILTERS} gespeicherte Filter`);
  if (input.isDefault) await clearDefault(db, userId);
  const [row] = await db
    .insert(savedFilters)
    .values({
      userId,
      scope: 'leads',
      name: input.name.trim(),
      filter: storable(input.filter),
      columns: input.columns ?? null,
      sort: input.sort ?? null,
      isDefault: input.isDefault ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toSaved(row);
}

export async function updateSavedFilter(db: Db, userId: string, id: string, input: Partial<SavedFilterInput>, now: Date): Promise<SavedLeadFilter> {
  const [existing] = await db.select().from(savedFilters).where(and(eq(savedFilters.id, id), eq(savedFilters.userId, userId), eq(savedFilters.scope, 'leads')));
  if (!existing) throw notFound('Filter nicht gefunden');
  if (input.isDefault) await clearDefault(db, userId, id);
  const [row] = await db
    .update(savedFilters)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.filter !== undefined ? { filter: storable(input.filter) } : {}),
      ...(input.columns !== undefined ? { columns: input.columns } : {}),
      ...(input.sort !== undefined ? { sort: input.sort } : {}),
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
      updatedAt: now,
    })
    .where(eq(savedFilters.id, id))
    .returning();
  return toSaved(row);
}

export async function deleteSavedFilter(db: Db, userId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(savedFilters)
    .where(and(eq(savedFilters.id, id), eq(savedFilters.userId, userId), eq(savedFilters.scope, 'leads')))
    .returning({ id: savedFilters.id });
  if (!deleted.length) throw notFound('Filter nicht gefunden');
}
