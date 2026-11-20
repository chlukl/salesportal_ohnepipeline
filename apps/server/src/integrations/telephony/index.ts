import type { AdapterDeps } from '../types';
import { LiveTelephonyAdapter } from './live';
import { MockTelephonyAdapter } from './mock';
import type { TelephonyAdapter } from './types';

export type { DialTarget, TelephonyAdapter } from './types';

export function createTelephonyAdapter(deps: Pick<AdapterDeps, 'config'>): TelephonyAdapter {
  return deps.config.adapters.telephony === 'live' ? new LiveTelephonyAdapter() : new MockTelephonyAdapter();
}
