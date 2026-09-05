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
} from "./claude-pricing.js";
import {
  GOOGLE_ROUTER_MODEL,
  isGoogleRouterModelRevision,
} from "./model-providers/google-generate-content-provider.js";
import { OPENAI_ROUTER_MODEL } from "./model-providers/openai-responses-provider.js";
import type {
  ModelProviderId,
  ModelUsage,
} from "./model-providers/model-provider.js";

export const GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION =
  "google-gemini-3.7-flash-through-2026-12-31" as const;

/**
 * This is the existing, reviewed Luna router price identity used by the
 * shadow/canary controls. Keep it literal: Terra and Sol have no adapter or
 * reviewed price entry and must not inherit Luna's availability or rate.
 */
export const OPENAI_GPT_5_6_LUNA_PRICING_VERSION =
  "openai-gpt-5.6-luna-2026-08-26" as const;

/**
 * The single reviewed Luna price identity.  Fixed-trace planning, reservation,
 * and settlement import this record rather than copying a near-match profile.
 * `inputTokens` includes cached input, so cached input is a subset replacement
 * (not an additional charge and not an uncached charge).
 */
export const OPENAI_GPT_5_6_LUNA_PRICING = Object.freeze({
  profileId: OPENAI_GPT_5_6_LUNA_PRICING_VERSION,
  inputUsdPerMillionTokens: 0.2,
  outputUsdPerMillionTokens: 1.2,
  cacheReadUsdPerMillionTokens: 0.02,
  cacheReadAccounting: "subset" as const,
  cacheWriteUsdPerMillionTokens: null,
  cacheWriteAccounting: "unsupported" as const,
  source:
    "Repository reviewed OpenAI Luna standard pricing, checked 2026-08-26.",
});

export interface ModelCostPricing {
  provider: ModelProviderId;
  model: string;
  version: string;
  validBefore: Date | null;
  estimateCostMicros: (usage: ModelUsage) => number;
}

/** A complete provider-normalized usage tuple is required for live charging. */
export function hasCompleteModelUsage(usage: unknown): usage is ModelUsage {
  if (!usage || typeof usage !== "object") return false;
  const value = usage as Record<string, unknown>;
  const isSafeCount = (count: unknown): count is number =>
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  return (
    isSafeCount(value.inputTokens) &&
    isSafeCount(value.outputTokens) &&
    (value.cacheReadTokens === undefined ||
      isSafeCount(value.cacheReadTokens)) &&
    (value.cacheWriteTokens === undefined ||
      isSafeCount(value.cacheWriteTokens))
  );
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
  if (provider === "openai" && model === OPENAI_ROUTER_MODEL) {
    return {
      provider: "openai",
      model: OPENAI_ROUTER_MODEL,
      version: OPENAI_GPT_5_6_LUNA_PRICING_VERSION,
      validBefore: null,
      estimateCostMicros: (usage) => {
        const cacheReadTokens = usage.cacheReadTokens ?? 0;
        const uncachedInputTokens =
          cacheReadTokens <= usage.inputTokens
            ? usage.inputTokens - cacheReadTokens
            : usage.inputTokens;
        return Math.ceil(
          uncachedInputTokens *
            OPENAI_GPT_5_6_LUNA_PRICING.inputUsdPerMillionTokens +
            cacheReadTokens *
              OPENAI_GPT_5_6_LUNA_PRICING.cacheReadUsdPerMillionTokens +
            usage.outputTokens *
              OPENAI_GPT_5_6_LUNA_PRICING.outputUsdPerMillionTokens,
        );
      },
    };
  }
  const canonicalAnthropicModel =
    provider === "anthropic" ? resolveKnownClaudePricingModel(model) : null;
  if (provider === "anthropic" && canonicalAnthropicModel) {
    return {
      provider: "anthropic",
      model,
      version: `${CLAUDE_PRICING_VERSION}:${canonicalAnthropicModel}`,
      validBefore: null,
      estimateCostMicros: (usage) =>
        costUsdMicros(canonicalAnthropicModel, {
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
  const canonicalGoogleModel =
    provider === "google" && isGoogleRouterModelRevision(model)
      ? GOOGLE_ROUTER_MODEL
      : null;
  if (canonicalGoogleModel) {
    return {
      provider: "google",
      model,
      version: GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION,
      validBefore: new Date("2027-01-01T00:00:00.000Z"),
      // Official standard pricing checked 2026-08-30: $0.75/M input,
      // $0.075/M cached input, and $3.75/M output (including thought tokens).
      // A cache-read count above input is charged in addition to all input,
      // rather than deriving a negative uncached-input count.
      estimateCostMicros: (usage) => {
        const cacheReadTokens = usage.cacheReadTokens ?? 0;
        const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
        const uncachedInput =
          cacheReadTokens <= usage.inputTokens
            ? usage.inputTokens - cacheReadTokens
            : usage.inputTokens;
        return Math.ceil(
          uncachedInput * 0.75 +
            cacheReadTokens * 0.075 +
            cacheWriteTokens * 0.75 +
            usage.outputTokens * 3.75,
        );
      },
    };
  }
  return null;
}
