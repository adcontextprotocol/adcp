import { describe, expect, it, vi } from 'vitest';
import { isRetryableError, withRetry } from '../../src/utils/anthropic-retry.js';

describe('isRetryableError', () => {
  it('retries Anthropic stream api_error messages wrapped as JSON', () => {
    const err = new Error(
      '{"type":"error","error":{"details":null,"type":"api_error","message":"Internal server error"},"request_id":"req_test"}',
    );

    expect(isRetryableError(err)).toBe(true);
  });

  it('retries Anthropic stream api_error messages prefixed with status text', () => {
    const err = new Error(
      '400 {"type":"error","error":{"details":null,"type":"api_error","message":"Internal server error"},"request_id":"req_test"}',
    );

    expect(isRetryableError(err)).toBe(true);
  });

  it('retries Anthropic rate_limit_error messages prefixed with status text', () => {
    const err = new Error(
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"},"request_id":"req_test"}',
    );

    expect(isRetryableError(err)).toBe(true);
  });

  it('does not retry Anthropic billing exhaustion', () => {
    const err = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_test"}',
    );

    expect(isRetryableError(err)).toBe(false);
  });

  it('does not retry billing exhaustion in withRetry', async () => {
    const err = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_test"}',
    );
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 1,
      maxDelayMs: 1,
      jitter: false,
    }, 'billing-test')).rejects.toThrow(/credit balance/i);

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
