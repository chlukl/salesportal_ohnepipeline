/**
 * Live AI adapter (Claude API via `@anthropic-ai/sdk`, key from ANTHROPIC_API_KEY / _FILE).
 *
 * - Models: config.ai.modelAnalysis (`claude-opus-5-5`: analysis, briefing), config.ai.modelMail (`claude-sonnet-5-5`: mail).
 * - Structured output: `output_config.format` with a strict JSON schema (forced `tool_choice` is rejected by these
 *   models). Every response is parsed and validated with zod; anything else is an error.
 * - Prompt injection: CRM/transcript/website text only inside delimited `<data>` blocks (prompts.ts).
 * - Refusals: server-side fallback (`fallbacks: 'default'`); a final refusal is an error, never a silent result.
 * - Timeouts per request, retries by the SDK (429/5xx). Logs contain ids, model and token counts only – never content.
 * - Cost: usage is converted to USD (pricing.ts); the monthly cap is enforced by the ai service before calling.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AiCallContext, Briefing, CallAnalysis, UseCaseMailDraft } from '@sales-portal/shared';
import { ZodError } from 'zod';
import { upstreamError } from '../../lib/errors';
import type { AdapterDeps } from '../types';
import { usageWithCost } from './pricing';
import { analysisPrompt, briefingPrompt, useCaseMailPrompt, type PromptPair } from './prompts';
import {
  BRIEFING_JSON_SCHEMA,
  CALL_ANALYSIS_JSON_SCHEMA,
  sanitizeBriefing,
  sanitizeCallAnalysis,
  sanitizeUseCaseMail,
  USE_CASE_MAIL_JSON_SCHEMA,
} from './schemas';
import type { AiAdapter, AiResult, BriefingRequest, UseCaseMailRequest } from './types';

const REQUEST_TIMEOUT_MS = 120_000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

interface CallOptions<T> {
  task: 'analysis' | 'use_case_mail' | 'briefing';
  model: string;
  prompt: PromptPair;
  schema: Record<string, unknown>;
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  sanitize: (raw: unknown) => T;
}

export class LiveAiAdapter implements AiAdapter {
  readonly mode = 'live' as const;
  private client: Anthropic | null = null;

  constructor(private readonly deps: AdapterDeps) {}

  private getClient(): Anthropic {
    if (this.client) return this.client;
    const apiKey = this.deps.config.ai.apiKey;
    if (!apiKey) throw upstreamError('KI ist nicht konfiguriert (API-Schlüssel fehlt)', 'ai_not_configured');
    this.client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 2 });
    return this.client;
  }

  private async call<T>(opts: CallOptions<T>): Promise<AiResult<T>> {
    const client = this.getClient();
    const log = this.deps.log.child({ component: 'ai.live', task: opts.task, model: opts.model });
    const started = Date.now();
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create(
        {
          model: opts.model,
          max_tokens: opts.maxTokens,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          system: opts.prompt.system,
          messages: [{ role: 'user', content: opts.prompt.user }],
          output_config: { effort: opts.effort, format: { type: 'json_schema', schema: opts.schema } },
        },
        { timeout: REQUEST_TIMEOUT_MS },
      );
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      log.warn({ status, ms: Date.now() - started }, 'claude request failed');
      if (err instanceof Anthropic.RateLimitError) throw upstreamError('KI ist gerade ausgelastet – bitte später nochmals versuchen', 'ai_rate_limited');
      throw upstreamError('KI nicht erreichbar – bitte später nochmals versuchen', 'ai_unavailable');
    }

    const usage = usageWithCost(response.model, response.usage);
    log.info({ ms: Date.now() - started, stop: response.stop_reason, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, 'claude request done');

    if (response.stop_reason === 'refusal') throw upstreamError('Die KI hat diese Anfrage abgelehnt', 'ai_refused');
    if (response.stop_reason === 'max_tokens') throw upstreamError('Die KI-Antwort war unvollständig', 'ai_incomplete');

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      log.warn('claude returned invalid JSON');
      throw upstreamError('Die KI-Antwort war ungültig', 'ai_invalid_output');
    }
    try {
      return { result: opts.sanitize(parsed), model: response.model, usage };
    } catch (err) {
      if (err instanceof ZodError) log.warn({ issues: err.issues.map((i) => i.path.join('.')) }, 'claude output failed validation');
      throw upstreamError('Die KI-Antwort war ungültig', 'ai_invalid_output');
    }
  }

  analyzeCall(ctx: AiCallContext): Promise<AiResult<CallAnalysis>> {
    return this.call({
      task: 'analysis',
      model: this.deps.config.ai.modelAnalysis,
      prompt: analysisPrompt(ctx, this.deps.now()),
      schema: CALL_ANALYSIS_JSON_SCHEMA,
      effort: 'medium',
      maxTokens: 16_000,
      sanitize: sanitizeCallAnalysis,
    });
  }

  draftUseCaseMail(req: UseCaseMailRequest): Promise<AiResult<UseCaseMailDraft>> {
    return this.call({
      task: 'use_case_mail',
      model: this.deps.config.ai.modelMail,
      prompt: useCaseMailPrompt(req, this.deps.now()),
      schema: USE_CASE_MAIL_JSON_SCHEMA,
      effort: 'medium',
      maxTokens: 8_000,
      sanitize: sanitizeUseCaseMail,
    });
  }

  buildBriefing(req: BriefingRequest): Promise<AiResult<Briefing>> {
    return this.call({
      task: 'briefing',
      model: this.deps.config.ai.modelAnalysis,
      prompt: briefingPrompt(req, this.deps.now()),
      schema: BRIEFING_JSON_SCHEMA,
      effort: 'medium',
      maxTokens: 16_000,
      sanitize: sanitizeBriefing,
    });
  }
}
