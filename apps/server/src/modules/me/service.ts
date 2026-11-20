import type { HeaderCounters, MeResponse } from '@sales-portal/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { RequestAuth } from '../../auth/rbac';
import type { AppConfig } from '../../config';
import type { Db } from '../../db/client';
import type { Adapters } from '../../integrations';
import type { CounterRegistry } from '../registry';

export function buildMe(auth: RequestAuth, config: AppConfig): MeResponse {
  return {
    user: { id: auth.user.id, email: auth.user.email, displayName: auth.user.displayName, crmUserId: auth.user.crmUserId },
    roles: auth.roles,
    effectiveRoles: auth.effectiveRoles,
    viewAs: auth.viewAs,
    isRealAdmin: auth.isRealAdmin,
    csrfToken: auth.csrfToken,
    environment: { label: config.environmentLabel, authMode: config.auth.mode, integrations: config.integrationsMode },
    features: { ...config.features },
  };
}

/** Sum all registered counter providers; a failing provider counts as 0 (logged), the header never breaks. */
export async function computeCounters(
  registry: CounterRegistry,
  ctx: { config: AppConfig; db: Db; auth: RequestAuth; adapters: Adapters; log: FastifyBaseLogger },
): Promise<HeaderCounters> {
  const result: HeaderCounters = { pendenzen: 0, analysen: 0, missedCallbacks: 0 };
  await Promise.all(
    (Object.keys(result) as (keyof HeaderCounters)[]).map(async (key) => {
      for (const { module, provider } of registry.get(key) ?? []) {
        try {
          result[key] += Math.max(0, Math.floor(await provider(ctx)));
        } catch (err) {
          ctx.log.warn({ err, module, counter: key }, 'counter provider failed');
        }
      }
    }),
  );
  return result;
}
