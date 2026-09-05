/**
 * Reviewed live pricing for provider-normalized Addie model usage.
 *
 * This is deliberately a static, exact provider/model registry. A provider
 * activation must add its rate here in the same reviewed change; it must not
 * inherit another provider's fallback rate.
 */

import {
  CLAUDE_PRICING_VERSION,
  costUsdMicros,
  resolveKnownClaudePricingModel,
} from './claude-pricing.js';
import {
  GOOGLE_ROUTER_MODEL,
  isGoogleRouterModelRevision,
} from './model-providers/google-generate-content-provider.js';
import type { ModelProviderId, ModelUsage } from './model-providers/model-provider.js';

export const GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION =
  'google-gemini-3.7-flash-through-2026-12-31' as const;

/**
 * Immutable OpenAI standard rates reviewed for the fixed-trace planning
 * contract on 2026-09-05. These are deliberately model-specific; callers
 * must not infer a rate for a new model or a returned revision suffix.
 */
export const OPENAI_GPT_5_6_PRICING_VERSION = 'openai-gpt-5.6-standard-2026-09-05' as const;
export const OPENAI_GPT_5_6_PRICING_PER_MILLION_TOKENS = Object.freeze({
  'gpt-5.6-luna': Object.freeze({ inputUsd: 0.20, outputUsd: 1.20 }),
  'gpt-5.6-terra': Object.freeze({ inputUsd: 2, outputUsd: 12 }),
  'gpt-5.6-sol': Object.freeze({ inputUsd: 4, outputUsd: 20 }),
} as const);

export interface ModelCostPricing {
  provider: ModelProviderId;
  model: string;
  version: string;
  validBefore: Date | null;
  estimateCostMicros: (usage: ModelUsage) => number;
}

/** A complete provider-normalized usage tuple is required for live charging. */
export function hasCompleteModelUsage(usage: unknown): usage is ModelUsage {
  if (!usage || typeof usage !== 'object') return false;
  const value = usage as Record<string, unknown>;
  const isSafeCount = (count: unknown): count is number =>
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  return isSafeCount(value.inputTokens)
    && isSafeCount(value.outputTokens)
    && (value.cacheReadTokens === undefined || isSafeCount(value.cacheReadTokens))
    && (value.cacheWriteTokens === undefined || isSafeCount(value.cacheWriteTokens));
}

/**
 * Resolve only reviewed provider/model rates. Provider adapters may return an
 * explicitly accepted dated revision of their requested canonical model; that
 * revision is recorded verbatim, while this registry prices it by the one
 * reviewed canonical rate. No other provider/model family is inferred.
 */
export function resolveModelCostPricing(
  provider: ModelProviderId | string,
  model: string,
): ModelCostPricing | null {
  const canonicalAnthropicModel = provider === 'anthropic'
    ? resolveKnownClaudePricingModel(model)
    : null;
  if (provider === 'anthropic' && canonicalAnthropicModel) {
    return {
      provider: 'anthropic',
      model,
      version: `${CLAUDE_PRICING_VERSION}:${canonicalAnthropicModel}`,
      validBefore: null,
      estimateCostMicros: (usage) => costUsdMicros(canonicalAnthropicModel, {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_input_tokens: usage.cacheReadTokens,
        cache_creation_input_tokens: usage.cacheWriteTokens,
      }),
    };
  }
  // Google Generate Content accepts this canonical router model and its
  // provider-returned eight-digit dated revisions (for example `...-20260801`). Keep this
  // mapping here, beside the reviewed rate, rather than falling back to any
  // other model or provider price.
  const canonicalGoogleModel = provider === 'google'
    && isGoogleRouterModelRevision(model)
    ? GOOGLE_ROUTER_MODEL
    : null;
  if (canonicalGoogleModel) {
    return {
      provider: 'google',
      model,
      version: GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION,
      validBefore: new Date('2027-01-01T00:00:00.000Z'),
      // Official standard pricing checked 2026-08-30: $0.75/M input,
      // $0.075/M cached input, and $3.75/M output (including thought tokens).
      // A cache-read count above input is charged in addition to all input,
      // rather than deriving a negative uncached-input count.
      estimateCostMicros: (usage) => {
        const cacheReadTokens = usage.cacheReadTokens ?? 0;
        const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
        const uncachedInput = cacheReadTokens <= usage.inputTokens
          ? usage.inputTokens - cacheReadTokens
          : usage.inputTokens;
        return Math.ceil(
          uncachedInput * 0.75
          + cacheReadTokens * 0.075
          + cacheWriteTokens * 0.75
          + usage.outputTokens * 3.75,
        );
      },
    };
  }
  if (provider === 'openai') {
    const rate = OPENAI_GPT_5_6_PRICING_PER_MILLION_TOKENS[
      model as keyof typeof OPENAI_GPT_5_6_PRICING_PER_MILLION_TOKENS
    ];
    if (!rate) return null;
    return {
      provider: 'openai',
      model,
      version: OPENAI_GPT_5_6_PRICING_VERSION,
      // The plan contract is intentionally date-pinned. A later plan must
      // add a reviewed profile instead of silently reusing this rate.
      validBefore: new Date('2026-09-06T00:00:00.000Z'),
      estimateCostMicros: (usage) => Math.ceil(
        usage.inputTokens * rate.inputUsd + usage.outputTokens * rate.outputUsd,
      ),
    };
  }
  return null;
}
