/**
 * Call-list state shared between the Anrufliste and the Lead-Arbeitsplatz («nächster Lead aus meiner Liste»).
 * The active filter and the leads already worked in this browser session live in sessionStorage (per tab, per viewer
 * convenience only – the server decides what is callable).
 */
import type { Lead, LeadQuery } from '@sales-portal/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, type QueryValue } from '@/app/api';

export type ListFilter = Omit<LeadQuery, 'page' | 'pageSize' | 'excludeLeadIds'>;

export const DEFAULT_FILTER: ListFilter = { sort: 'due_then_score' };

const FILTER_KEY = 'sp.anrufliste.filter';
const WORKED_KEY = 'sp.anrufliste.worked';
const PAGE_KEY = 'sp.anrufliste.page';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable – the list still works, only «nächster Lead» uses the default filter */
  }
}

export const listSession = {
  hasFilter: () => {
    try {
      return sessionStorage.getItem(FILTER_KEY) != null;
    } catch {
      return false;
    }
  },
  filter: (): ListFilter => readJson(FILTER_KEY, DEFAULT_FILTER),
  setFilter: (f: ListFilter) => writeJson(FILTER_KEY, f),
  page: (): number => readJson(PAGE_KEY, 1),
  setPage: (p: number) => writeJson(PAGE_KEY, p),
  worked: (): string[] => readJson<string[]>(WORKED_KEY, []),
  markWorked: (leadId: string) => {
    const list = readJson<string[]>(WORKED_KEY, []).filter((id) => id !== leadId);
    writeJson(WORKED_KEY, [...list, leadId].slice(-400));
  },
  unmarkWorked: (leadId: string) => writeJson(WORKED_KEY, readJson<string[]>(WORKED_KEY, []).filter((id) => id !== leadId)),
};

/** LeadQuery → query-string params for GET /api/leads (arrays as csv, empty values dropped). */
export function toParams(q: LeadQuery): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length) out[k] = v as (string | number)[];
    } else out[k] = v as QueryValue;
  }
  return out;
}

/** Number of active filters (for the «Weitere Filter» badge). */
export function countFilters(f: ListFilter, keys: (keyof ListFilter)[]): number {
  return keys.filter((k) => {
    const v = f[k];
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '';
  }).length;
}

export async function fetchNextLead(currentLeadId: string | undefined): Promise<Lead | null> {
  const res = await api.get<{ lead: Lead | null }>('/api/leads/next', {
    ...toParams(listSession.filter()),
    currentLeadId,
    skip: listSession.worked().filter((id) => id !== currentLeadId).slice(-300),
  });
  return res.lead;
}

/**
 * Next lead of the user's list, prefetched in the background together with its workspace (INTENT 6.0 «Schnell»).
 * `enabled` false while a call is running.
 */
export function useNextLead(currentLeadId: string | undefined, enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['leads', 'next', currentLeadId],
    queryFn: () => fetchNextLead(currentLeadId),
    enabled: !!currentLeadId && enabled,
    staleTime: 60_000,
  });
  const nextId = query.data?.leadid;
  useEffect(() => {
    if (!nextId) return;
    void queryClient.prefetchQuery({ queryKey: ['workspace', nextId], queryFn: () => api.get(`/api/workspace/${nextId}`), staleTime: 60_000 });
  }, [nextId, queryClient]);
  return query;
}
