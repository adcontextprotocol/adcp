import { describe, expect, it } from 'vitest';
import { resolveModelCostPricing } from '../../../src/addie/model-cost-pricing.js';

describe('live Luna router pricing', () => {
  const price = resolveModelCostPricing('openai', 'gpt-5.6-luna')!;

  it('accounts for cache reads and writes as subsets of input, and reasoning as part of output', () => {
    expect(price.estimateCostMicros({
      inputTokens: 1000, outputTokens: 200, cacheReadTokens: 200, cacheWriteTokens: 100, reasoningTokens: 100,
    })).toBe(409);
  });

  it('applies the long-context premium only above the documented threshold', () => {
    expect(price.estimateCostMicros({ inputTokens: 272_000, outputTokens: 1000 })).toBe(55_600);
    expect(price.estimateCostMicros({ inputTokens: 272_001, outputTokens: 1000 })).toBe(110_601);
  });

  it.each(['gpt-5.6-luna-unknown', 'gpt-5.6-terra', 'gpt-5.6-sol'])('does not infer a rate for %s', model => {
    expect(resolveModelCostPricing('openai', model)).toBeNull();
  });
});
