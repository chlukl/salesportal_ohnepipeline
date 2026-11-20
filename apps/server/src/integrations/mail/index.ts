import type { AdapterDeps } from '../types';
import { LiveMailAdapter } from './live';
import { MockMailAdapter } from './mock';
import type { MailAdapter } from './types';

export type { MailAdapter, MailSender } from './types';

export function createMailAdapter(deps: AdapterDeps): MailAdapter {
  return deps.config.adapters.mail === 'live' ? new LiveMailAdapter(deps) : new MockMailAdapter(deps);
}
