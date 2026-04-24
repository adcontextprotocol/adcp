/**
 * Claude model pricing in USD per token (publicly listed rates).
 *
 * Used by the per-user cost cap (#2790) to translate Anthropic API
 * usage into a rolling-window spend that we can gate on. Kept as
 * literal constants rather than in the DB because:
 *   - Pricing is product-wide, not per-tenant.
 *   - Changes land via PR review (diffable, reviewable, traceable).
 *   - Runtime-mutable pricing is a confusing surface and a security
 *     risk (an attacker who gains DB access could bump the effective
 *     cap by rewriting pricing).
 *
 * Update these alongside Anthropic's pricing page when model rates
 * change. Last refresh: April 2026.
 */

/** Per-million-token prices. Converted to per-token via × 1/1_000_000 downstream. */
interface ModelRates {
  inputUsd: number;
  outputUsd: number;
  /** `cache_creation_input_tokens` — prompt caching write pricing. */
  cacheCreationUsd: number;
  /** `cache_read_input_tokens` — prompt caching read pricing. */
  cacheReadUsd: number;
}

const PRICING_PER_MILLION_TOKENS: Record<string, ModelRates> = {
  // Claude Opus 4.x — premium tier
  'claude-opus-4-6': { inputUsd: 15, outputUsd: 75, cacheCreationUsd: 18.75, cacheReadUsd: 1.5 },
  'claude-opus-4-7': { inputUsd: 15, outputUsd: 75, cacheCreationUsd: 18.75, cacheReadUsd: 1.5 },
  // Claude Sonnet 4.x — balanced tier (most Addie calls)
  'claude-sonnet-4-5': { inputUsd: 3, outputUsd: 15, cacheCreationUsd: 3.75, cacheReadUsd: 0.3 },
  'claude-sonnet-4-6': { inputUsd: 3, outputUsd: 15, cacheCreationUsd: 3.75, cacheReadUsd: 0.3 },
  // Claude Haiku 4.x — fast / cheap tier (routing, classification)
  'claude-haiku-4-5': { inputUsd: 1, outputUsd: 5, cacheCreationUsd: 1.25, cacheReadUsd: 0.1 },
};

/**
 * Fallback rates applied to unknown model IDs (new model ships before
 * this table is updated). Conservatively priced as Opus so the cost
 * cap won't accidentally give away premium usage while we catch up.
 */
const UNKNOWN_MODEL_FALLBACK: ModelRates = PRICING_PER_MILLION_TOKENS['claude-opus-4-7'];

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Compute the USD cost of a single Claude API response in micros
 * (1/1,000,000 of a dollar). Integer math throughout so a day's worth
 * of tiny calls can be summed without floating-point drift.
 *
 * Unknown model IDs fall through to the Opus rate — overestimating
 * cost is safer than underestimating for a security gate.
 */
export function costUsdMicros(model: string, usage: ClaudeUsage): number {
  const rates = PRICING_PER_MILLION_TOKENS[model] ?? UNKNOWN_MODEL_FALLBACK;
  // Guard against upstream weirdness: NaN would poison the running
  // total, negatives would silently credit the user, Infinity would
  // saturate the Postgres BIGINT column. Anthropic doesn't emit any
  // of these today, but the function has no contract saying so —
  // clamp each token field to a non-negative finite integer before
  // pricing. Zero is the safe fallback: under-charging a single
  // response by a handful of micros is strictly preferable to
  // letting a single malformed response disable the cap.
  const safeTokens = (v: number | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

  // Rate is per-million-tokens, answer is per-token; integer math
  // directly in micros avoids float accumulation across calls.
  //
  // costUsd    = (tokens / 1e6) * rateUsdPerMillion
  // costMicros = costUsd * 1e6
  //            = tokens * rateUsdPerMillion
  //
  // So tokens * rate is already in micros.
  const inputMicros = safeTokens(usage.input_tokens) * rates.inputUsd;
  const outputMicros = safeTokens(usage.output_tokens) * rates.outputUsd;
  const cacheCreationMicros = safeTokens(usage.cache_creation_input_tokens) * rates.cacheCreationUsd;
  const cacheReadMicros = safeTokens(usage.cache_read_input_tokens) * rates.cacheReadUsd;
  const total = inputMicros + outputMicros + cacheCreationMicros + cacheReadMicros;
  return Math.ceil(total);
}

/** Test-only helper to assert a model has known pricing. */
export function __hasKnownPricing(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRICING_PER_MILLION_TOKENS, model);
}
