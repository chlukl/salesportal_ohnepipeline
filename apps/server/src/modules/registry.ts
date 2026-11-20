/**
 * Module contract. Each module folder has an `index.ts` exporting `defineModule({...})`; `modules/index.ts` lists them
 * all (prepared by the foundation – implementers only edit inside their own folder).
 *
 *   export default defineModule({
 *     name: 'leads',                       // routes are mounted under /api/leads
 *     routes: leadsRoutes,                 // FastifyPluginAsyncZod, every route with config: requireRoles(...)
 *     counters: { pendenzen: async (ctx) => 3 },   // header counters (summed over modules)
 *     jobs(registry) { registry.register('leads.x', handler) },  // worker handlers
 *   });
 */
import type { CounterKey } from '@sales-portal/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { RequestAuth } from '../auth/rbac';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import type { Adapters } from '../integrations';
import type { JobRegistry } from '../jobs/registry';

export interface CounterContext {
  config: AppConfig;
  db: Db;
  auth: RequestAuth;
  /** Adapters acting for the current user. */
  adapters: Adapters;
  log: FastifyBaseLogger;
}

/** Returns the count for the current user (respect effective roles / «Ansicht als»). */
export type CounterProvider = (ctx: CounterContext) => Promise<number>;

export interface PortalModule {
  name: string;
  /** Mount point below /api (default: name). */
  prefix?: string;
  routes: FastifyPluginAsyncZod;
  counters?: Partial<Record<CounterKey, CounterProvider>>;
  jobs?: (registry: JobRegistry) => void;
}

export function defineModule(module: PortalModule): PortalModule {
  return module;
}

export type CounterRegistry = Map<CounterKey, { module: string; provider: CounterProvider }[]>;

export function collectCounters(modules: PortalModule[]): CounterRegistry {
  const registry: CounterRegistry = new Map();
  for (const m of modules) {
    for (const [key, provider] of Object.entries(m.counters ?? {}) as [CounterKey, CounterProvider][]) {
      const list = registry.get(key) ?? [];
      list.push({ module: m.name, provider });
      registry.set(key, list);
    }
  }
  return registry;
}

export function registerModuleJobs(modules: PortalModule[], registry: JobRegistry): void {
  for (const m of modules) m.jobs?.(registry);
}
