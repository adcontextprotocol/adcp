import { describe, it, expect } from 'vitest';
import { costUsdMicros, __hasKnownPricing } from '../../src/addie/claude-pricing.js';

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

  it('prices Sonnet at $3/M input, $15/M output', () => {
    // 10k input, 5k output: 10_000*3 + 5_000*15 = 30_000 + 75_000 = 105_000 micros ($0.105)
    expect(costUsdMicros('claude-sonnet-4-6', { input_tokens: 10_000, output_tokens: 5_000 })).toBe(105_000);
  });

  it('prices Opus at $15/M input, $75/M output', () => {
    // 1000 input, 500 output: 1000*15 + 500*75 = 15_000 + 37_500 = 52_500 micros
    expect(costUsdMicros('claude-opus-4-7', { input_tokens: 1000, output_tokens: 500 })).toBe(52_500);
  });

  it('applies cache-creation and cache-read rates (Sonnet)', () => {
    // 1000 input@3, 500 output@15, 2000 creation@3.75, 500 read@0.3
    // = 3000 + 7500 + 7500 + 150 = 18_150 micros
    expect(costUsdMicros('claude-sonnet-4-6', {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 500,
    })).toBe(18_150);
  });

  it('treats missing cache fields as zero', () => {
    expect(costUsdMicros('claude-haiku-4-5', { input_tokens: 100, output_tokens: 50 })).toBe(
      100 * 1 + 50 * 5,
    );
  });

  it('falls back to Opus pricing for unknown models (overestimate rather than underestimate)', () => {
    // If Anthropic ships a new model before this table is updated,
    // the gate still charges conservatively. 1000 input at Opus rate
    // = 1000 * 15 = 15_000 micros. Matches explicit Opus call.
    const unknownCost = costUsdMicros('claude-made-up-9-0', { input_tokens: 1000, output_tokens: 0 });
    const opusCost = costUsdMicros('claude-opus-4-7', { input_tokens: 1000, output_tokens: 0 });
    expect(unknownCost).toBe(opusCost);
  });

  it('ceilings fractional results so a sub-micro charge still increments the counter', () => {
    // 1 token at Haiku ($1/M): 1 * 1 = 1 micro. Integer already.
    // 1 token at Sonnet cache-read ($0.3/M): 1 * 0.3 = 0.3 → ceil to 1.
    expect(costUsdMicros('claude-sonnet-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1,
    })).toBe(1);
  });

  it('is zero for a zero-usage response (rare but possible)', () => {
    expect(costUsdMicros('claude-haiku-4-5', { input_tokens: 0, output_tokens: 0 })).toBe(0);
  });
});

describe('__hasKnownPricing', () => {
  it('returns true for supported models', () => {
    expect(__hasKnownPricing('claude-sonnet-4-6')).toBe(true);
    expect(__hasKnownPricing('claude-haiku-4-5')).toBe(true);
    expect(__hasKnownPricing('claude-opus-4-7')).toBe(true);
  });

  it('returns false for unknown models', () => {
    expect(__hasKnownPricing('claude-made-up')).toBe(false);
  });
});
