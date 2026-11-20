import type { AdapterDeps } from '../types';
import { LiveTranscriptAdapter } from './live';
import { MockTranscriptAdapter } from './mock';
import type { TranscriptAdapter } from './types';

export type { TranscriptAdapter, TranscriptFetchResult, TranscriptRef } from './types';

export function createTranscriptAdapter(deps: AdapterDeps): TranscriptAdapter {
  return deps.config.adapters.transcripts === 'live' ? new LiveTranscriptAdapter(deps) : new MockTranscriptAdapter(deps);
}
