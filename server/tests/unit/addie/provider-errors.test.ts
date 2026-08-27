import { describe, expect, it } from 'vitest';
import {
  classifyProviderFailure,
  getProviderRetryAfterSeconds,
} from '../../../src/addie/model-providers/provider-errors.js';

describe('provider error classification', () => {
  it('classifies Anthropic credit exhaustion without treating it as a retryable request error', () => {
    const error = Object.assign(new Error(
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.',
    ), { status: 400 });

    expect(classifyProviderFailure('anthropic', error)).toEqual({
      category: 'billing_exhausted',
      status: 400,
    });
  });

  it('classifies OpenAI quota exhaustion from its bounded error code', () => {
    const error = { status: 429, error: { code: 'insufficient_quota' } };

    expect(classifyProviderFailure('openai', error).category).toBe('billing_exhausted');
  });

  it('keeps ordinary rate limits distinct from billing exhaustion', () => {
    const error = {
      status: 429,
      headers: { 'retry-after': '12.2' },
      error: { type: 'rate_limit_error' },
    };

    expect(classifyProviderFailure('anthropic', error, 0)).toEqual({
      category: 'rate_limited',
      retryAfterSeconds: 13,
      status: 429,
    });
  });

  it('classifies overload, timeout, and provider unavailability', () => {
    expect(classifyProviderFailure('anthropic', { status: 529 }).category).toBe('overloaded');
    expect(classifyProviderFailure('anthropic', new Error('overloaded_error: provider busy')).category).toBe('overloaded');
    expect(classifyProviderFailure('google', new Error('request timed out')).category).toBe('timeout');
    expect(classifyProviderFailure('openai', { status: 503 }).category).toBe('unavailable');
  });
});

describe('Retry-After parsing', () => {
  it('parses numeric seconds from Headers-like objects', () => {
    const error = { headers: new Headers({ 'retry-after': '7' }) };
    expect(getProviderRetryAfterSeconds(error, 0)).toBe(7);
  });

  it('parses HTTP dates and unwraps retry errors', () => {
    const error = {
      cause: {
        headers: { 'Retry-After': 'Thu, 01 Jan 1970 00:00:09 GMT' },
      },
    };
    expect(getProviderRetryAfterSeconds(error, 1_000)).toBe(8);
  });

  it('rejects invalid values and bounds hostile durations', () => {
    expect(getProviderRetryAfterSeconds({ headers: { 'retry-after': 'later' } }, 0)).toBeUndefined();
    expect(getProviderRetryAfterSeconds({ headers: { 'retry-after': '999999' } }, 0)).toBe(3600);
  });
});
