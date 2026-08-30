import {
  CLAUDE_PRICING_VERSION,
  costUsdMicros,
  hasKnownClaudePricing,
} from '../claude-pricing.js';
import type { ModelProviderId } from '../model-providers/model-provider.js';
import { GOOGLE_ROUTER_MODEL } from '../model-providers/google-generate-content-provider.js';

export const GOOGLE_SHADOW_REPLAY_PRICING_VERSION =
  'google-gemini-3.7-flash-through-2026-12-31' as const;

export interface ShadowReplayUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ShadowReplayPricing {
  provider: ModelProviderId;
  model: string;
  version: string;
  validBefore: Date | null;
  estimateCostMicros: (usage: ShadowReplayUsage) => number;
}

/** Resolve only exact, reviewed rates. Unknown models are not safe to spend on. */
export function resolveShadowReplayPricing(
  provider: ModelProviderId,
  model: string,
): ShadowReplayPricing | null {
  if (provider === 'anthropic' && hasKnownClaudePricing(model)) {
    return {
      provider,
      model,
      version: `${CLAUDE_PRICING_VERSION}:${model}`,
      validBefore: null,
      estimateCostMicros: (usage) => costUsdMicros(model, {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_input_tokens: usage.cacheReadTokens,
        cache_creation_input_tokens: usage.cacheWriteTokens,
      }),
    };
  }
  if (provider === 'google' && model === GOOGLE_ROUTER_MODEL) {
    return {
      provider,
      model,
      version: GOOGLE_SHADOW_REPLAY_PRICING_VERSION,
      validBefore: new Date('2027-01-01T00:00:00.000Z'),
      // Official standard pricing checked 2026-08-30: $0.75/M input,
      // $0.075/M cached input, and $3.75/M output (including thought tokens).
      // A malformed cache count is conservatively charged in addition to the
      // full input count instead of allowing a negative uncached denominator.
      estimateCostMicros: (usage) => {
        const cacheWithinInput = usage.cacheReadTokens <= usage.inputTokens;
        const uncachedInput = cacheWithinInput
          ? usage.inputTokens - usage.cacheReadTokens
          : usage.inputTokens;
        return Math.ceil(
          uncachedInput * 0.75
          + usage.cacheReadTokens * 0.075
          + usage.cacheWriteTokens * 0.75
          + usage.outputTokens * 3.75,
        );
      },
    };
  }
  return null;
}
