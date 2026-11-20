import type { AdapterDeps } from '../types';
import { LiveCrmAdapter } from './live';
import { MockCrmAdapter } from './mock';
import type { CrmAdapter } from './types';

export type { CrmAdapter, CrmEntity, CrmFilterOptions, CrmUser, PhoneCallPatch } from './types';

export function createCrmAdapter(deps: AdapterDeps): CrmAdapter {
  return deps.config.adapters.crm === 'live' ? new LiveCrmAdapter(deps) : new MockCrmAdapter(deps);
}
