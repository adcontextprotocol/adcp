import {
  GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION,
  resolveModelCostPricing,
} from '../model-cost-pricing.js';
import type { ModelProviderId } from '../model-providers/model-provider.js';

export const GOOGLE_SHADOW_REPLAY_PRICING_VERSION =
  GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION;

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
  const pricing = resolveModelCostPricing(provider, model);
  if (!pricing) return null;
  return {
    ...pricing,
    estimateCostMicros: (usage) => pricing.estimateCostMicros(usage),
  };
}
