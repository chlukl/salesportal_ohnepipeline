import type { AdapterDeps } from '../types';
import { LiveAiAdapter } from './live';
import { MockAiAdapter } from './mock';
import type { AiAdapter } from './types';

export type { AiAdapter, AiResult, AiUsage, BriefingRequest, UseCaseMailRequest } from './types';

export function createAiAdapter(deps: AdapterDeps): AiAdapter {
  return deps.config.adapters.ai === 'live' ? new LiveAiAdapter(deps) : new MockAiAdapter(deps);
}
