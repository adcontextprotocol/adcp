import { describe, it, expect, vi } from 'vitest';
import { withGeminiRetry } from '../../src/utils/gemini-retry.js';

const FAST_CONFIG = { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 };

describe('withGeminiRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withGeminiRetry(fn, FAST_CONFIG);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([
    '503 Service Unavailable',
    '429 Too Many Requests',
    'Resource has been exhausted',
    'The model is overloaded due to high demand',
    'UNAVAILABLE: server not ready',
    'RESOURCE_EXHAUSTED',
    'fetch failed',
    'read ECONNRESET',
    'connect ETIMEDOUT',
    'getaddrinfo ENOTFOUND generativelanguage.googleapis.com',
  ])('retries on "%s"', async (message) => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValue('ok');
    const result = await withGeminiRetry(fn, FAST_CONFIG);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Invalid API key'));
    await expect(withGeminiRetry(fn, FAST_CONFIG)).rejects.toThrow('Invalid API key');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry when a non-Error value is thrown', async () => {
    const fn = vi.fn().mockRejectedValue('string error');
    await expect(withGeminiRetry(fn, FAST_CONFIG)).rejects.toBe('string error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('503'));
    await expect(withGeminiRetry(fn, FAST_CONFIG)).rejects.toThrow('503');
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});
