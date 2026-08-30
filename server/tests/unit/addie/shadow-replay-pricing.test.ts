import { describe, expect, it } from 'vitest';
import {
  GOOGLE_SHADOW_REPLAY_PRICING_VERSION,
  resolveShadowReplayPricing,
} from '../../../src/addie/jobs/shadow-replay-pricing.js';

describe('shadow replay pricing', () => {
  it('prices exact Anthropic usage including cache reads and writes', () => {
    const pricing = resolveShadowReplayPricing('anthropic', 'claude-sonnet-5');
    expect(pricing?.version).toBe('anthropic-standard-2026-08:claude-sonnet-5');
    expect(pricing?.estimateCostMicros({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 200,
    })).toBe(1_650);
  });

  it('prices only the exact reviewed Google model', () => {
    const pricing = resolveShadowReplayPricing('google', 'gemini-3.7-flash');
    expect(pricing?.version).toBe(GOOGLE_SHADOW_REPLAY_PRICING_VERSION);
    expect(pricing?.validBefore?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(pricing?.estimateCostMicros({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
    })).toBe(137);
    expect(resolveShadowReplayPricing('google', 'gemini-unreviewed')).toBeNull();
  });

  it('fails closed for unsupported provider/model price tables', () => {
    expect(resolveShadowReplayPricing('anthropic', 'claude-unreviewed')).toBeNull();
    expect(resolveShadowReplayPricing('openai', 'gpt-unreviewed')).toBeNull();
  });
});
