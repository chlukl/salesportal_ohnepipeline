/**
 * AI adapter (INTENT 6.4, 6.7, 6.10). Live: `@anthropic-ai/sdk`, model `claude-opus-5-5` for analysis/briefing and
 * `claude-sonnet-5-5` for mail drafts, structured output via JSON schema. CRM/transcript text is passed as clearly
 * separated DATA blocks (prompt injection); outputs are always suggestions (change set with approval).
 *
 * Every adapter result is validated with zod (`schemas.ts`) before it leaves the adapter.
 */
import type { AiCallContext, Booking, Briefing, CallAnalysis, UseCaseMailDraft } from '@sales-portal/shared';

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface AiResult<T> {
  result: T;
  model: string;
  usage: AiUsage | null;
}

export interface UseCaseMailRequest extends AiCallContext {
  /** Allow a small web research (website, one search) – sources must be returned. */
  research: boolean;
  /** Optional text block with 3 proposals to embed. */
  proposalsText?: string | null;
  senderName: string;
  /**
   * Research text prepared by the service (SSRF-safe website fetch in live mode, canned text in mock mode).
   * Untrusted data – passed to the model in its own data block.
   */
  researchText?: string | null;
  /** Label of the research source (e.g. «Website example.ch»), used for `sources`. */
  researchSource?: string | null;
}

export interface BriefingRequest extends AiCallContext {
  booking: Booking;
  salesName: string;
  specialistName: string;
}

export interface AiAdapter {
  readonly mode: 'mock' | 'live';
  analyzeCall(ctx: AiCallContext): Promise<AiResult<CallAnalysis>>;
  draftUseCaseMail(req: UseCaseMailRequest): Promise<AiResult<UseCaseMailDraft>>;
  buildBriefing(req: BriefingRequest): Promise<AiResult<Briefing>>;
}
