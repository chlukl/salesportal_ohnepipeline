/**
 * Token pricing (USD per 1M tokens, Anthropic first-party list prices, cached 2026-11) for the monthly cost cap.
 * Unknown models are priced conservatively high so the cap errs on the safe side.
 */
import type { AiUsage } from './types';

interface Price {
  input: number;
  output: number;
}

const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};
const FALLBACK_PRICE: Price = { input: 10, output: 50 };

export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function priceFor(model: string): Price {
  return PRICES[model] ?? FALLBACK_PRICE;
}

/** Usage → AiUsage with an estimated cost (cache writes 1.25×, cache reads 0.1× the input price). */
export function usageWithCost(model: string, usage: RawUsage): AiUsage {
  const p = priceFor(model);
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const inputTokens = usage.input_tokens + cacheWrite + cacheRead;
  const costUsd =
    (usage.input_tokens * p.input + cacheWrite * p.input * 1.25 + cacheRead * p.input * 0.1 + usage.output_tokens * p.output) / 1_000_000;
  return { inputTokens, outputTokens: usage.output_tokens, costUsd: Math.round(costUsd * 1_000_000) / 1_000_000 };
}
