/**
 * Transcript adapter (Vera). The transfer path (API, webhook, export) is open (INTENT open question 2).
 * Transcripts only live in the portal DB with `delete_after` (retention job); never written to the CRM.
 */
import type { IsoDateTime, Transcript } from '@sales-portal/shared';

export interface TranscriptRef {
  callSessionId: string;
  /** Vera reference, if known (e.g. from a webhook). */
  externalRef: string | null;
  phoneE164: string | null;
  startedAt: IsoDateTime | null;
  endedAt: IsoDateTime | null;
  userEmail: string;
}

export type TranscriptFetchResult =
  | { status: 'ready'; transcript: Omit<Transcript, 'id' | 'fetchedAt' | 'deleteAfter'> }
  | { status: 'pending' }
  | { status: 'unavailable'; reason: string };

export interface TranscriptAdapter {
  readonly mode: 'mock' | 'live';
  fetchTranscript(ref: TranscriptRef): Promise<TranscriptFetchResult>;
}
