import { describe, it, expect } from 'vitest';
import {
  __hasKnownPricing,
  costUsdMicros,
  resolveKnownClaudePricingModel,
} from '../../src/addie/claude-pricing.js';

/**
 * #2790 — pricing helper. Converts Anthropic `usage` to USD micros
 * (1/1,000,000 of a dollar) using per-model rates. Integer math so a
 * day's worth of tiny calls can be summed without floating-point drift.
 */

describe('costUsdMicros', () => {
  it('prices Haiku input tokens at $1/M', () => {
    // 1,000,000 input tokens × $1/M = $1.00 = 1,000,000 micros
    expect(costUsdMicros('claude-haiku-4-5', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(1_000_000);
  });

  it('prices Sonnet 5 at $2/M input and $10/M output', () => {
    // 10k input, 5k output: 10_000*2 + 5_000*10 = 70_000 micros ($0.070)
    expect(costUsdMicros('claude-sonnet-5', { input_tokens: 10_000, output_tokens: 5_000 })).toBe(70_000);
  });

  it('prices Opus at $5/M input, $25/M output', () => {
    // 1000 input, 500 output: 1000*5 + 500*25 = 5_000 + 12_500 = 17_500 micros
    expect(costUsdMicros('claude-opus-5', { input_tokens: 1000, output_tokens: 500 })).toBe(17_500);
  });

  it('applies Sonnet 5 5-minute cache-creation and cache-read rates', () => {
    // 1000 input@2, 500 output@10, 2000 creation@2.5, 500 read@0.2
    // = 2000 + 5000 + 5000 + 100 = 12_100 micros
    expect(costUsdMicros('claude-sonnet-5', {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 500,
    })).toBe(12_100);
  });

  it('treats missing cache fields as zero', () => {
    expect(costUsdMicros('claude-haiku-4-5', { input_tokens: 100, output_tokens: 50 })).toBe(
      100 * 1 + 50 * 5,
    );
  });

  it('falls back to Fable pricing for unknown models (overestimate rather than underestimate)', () => {
    // If Anthropic ships a new model before this table is updated,
    // the gate still charges conservatively. 1000 input at Fable rate
    // = 1000 * 10 = 10_000 micros. Matches explicit Fable call.
    const unknownCost = costUsdMicros('claude-made-up-9-0', { input_tokens: 1000, output_tokens: 0 });
    const fableCost = costUsdMicros('claude-fable-5', { input_tokens: 1000, output_tokens: 0 });
    expect(unknownCost).toBe(fableCost);
  });

  it('ceilings fractional results so a sub-micro charge still increments the counter', () => {
    // 1 token at Haiku ($1/M): 1 * 1 = 1 micro. Integer already.
    // 1 token at Sonnet 5 cache-read ($0.2/M): 1 * 0.2 = 0.2 → ceil to 1.
    expect(costUsdMicros('claude-sonnet-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1,
    })).toBe(1);
  });

  it('is zero for a zero-usage response (rare but possible)', () => {
    expect(costUsdMicros('claude-haiku-4-5', { input_tokens: 0, output_tokens: 0 })).toBe(0);
  });
});

describe('resolveKnownClaudePricingModel', () => {
  it('maps a dated Sonnet 5 response to its reviewed canonical rate', () => {
    expect(resolveKnownClaudePricingModel('claude-sonnet-5-20260905')).toBe('claude-sonnet-5');
  });

  it('does not resolve an unknown model family', () => {
    expect(resolveKnownClaudePricingModel('claude-sonnet-6-20260905')).toBeNull();
  });
});

describe('__hasKnownPricing', () => {
  it('returns true for supported models', () => {
    expect(__hasKnownPricing('claude-sonnet-5')).toBe(true);
    expect(__hasKnownPricing('claude-haiku-4-5')).toBe(true);
    expect(__hasKnownPricing('claude-opus-5')).toBe(true);
    expect(__hasKnownPricing('claude-fable-5')).toBe(true);
  });

  it('returns false for unknown models', () => {
    expect(__hasKnownPricing('claude-made-up')).toBe(false);
  });
});
