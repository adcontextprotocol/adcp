import { APIError, APIConnectionError } from '@anthropic-ai/sdk';
import { isRetryableError, withRetry } from '../../server/src/utils/anthropic-retry.js';

describe('anthropic-retry utilities', () => {
  describe('isRetryableError', () => {
    it('returns true for APIConnectionError', () => {
      const error = new APIConnectionError({ message: 'Connection failed' });
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for 500+ status codes', () => {
      const error = new APIError(500, { type: 'error' }, 'Internal Server Error', new Headers());
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for 529 overloaded status', () => {
      const error = new APIError(529, { type: 'error' }, 'Overloaded', new Headers());
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for 429 rate limit errors', () => {
      const error = new APIError(429, { type: 'error' }, 'Rate limited', new Headers());
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for overloaded_error in error body', () => {
      const error = new APIError(
        undefined,
        { type: 'overloaded_error', message: 'Overloaded' },
        'Overloaded',
        undefined
      );
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for nested overloaded_error in error body', () => {
      const error = new APIError(
        undefined,
        { error: { type: 'overloaded_error', message: 'Overloaded' } },
        'Overloaded',
        undefined
      );
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for overloaded_error in message', () => {
      const error = new Error(
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
      );
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns false for 400 bad request errors', () => {
      const error = new APIError(400, { type: 'error' }, 'Bad request', new Headers());
      expect(isRetryableError(error)).toBe(false);
    });

    it('returns false for 401 authentication errors', () => {
      const error = new APIError(401, { type: 'error' }, 'Unauthorized', new Headers());
      expect(isRetryableError(error)).toBe(false);
    });

    it('returns false for generic errors', () => {
      const error = new Error('Something went wrong');
      expect(isRetryableError(error)).toBe(false);
    });

    it('returns false for non-error values', () => {
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
      expect(isRetryableError('string error')).toBe(false);
    });
  });

  describe('withRetry', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns result on successful first attempt', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const promise = withRetry(fn);

      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on retryable errors and succeeds', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new APIConnectionError({ message: 'Connection failed' }))
        .mockResolvedValueOnce('success');

      const promise = withRetry(fn, { maxRetries: 2, initialDelayMs: 100, jitter: false });

      // First attempt fails immediately
      await jest.advanceTimersByTimeAsync(0);

      // Wait for the delay
      await jest.advanceTimersByTimeAsync(100);

      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws non-retryable errors immediately', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('Test network error'));

      // Since a generic Error is not retryable, it should throw immediately without delay
      await expect(
        withRetry(fn, { maxRetries: 2, initialDelayMs: 100, jitter: false })
      ).rejects.toThrow('Test network error');

      expect(fn).toHaveBeenCalledTimes(1); // Only called once - not retried
    });

    it('exhausts retries on retryable errors', async () => {
      // Use 500 error which is retryable
      // Create error once to avoid multiple instances
      const serverError = new APIError(500, {}, 'Server error', new Headers());
      const fn = jest.fn().mockRejectedValue(serverError);

      // Don't use fake timers for this test - they interact poorly with unhandled rejection tracking
      jest.useRealTimers();

      // APIError formats message as "status error_body" when error_body has no message
      await expect(
        withRetry(fn, { maxRetries: 2, initialDelayMs: 10, jitter: false })
      ).rejects.toThrow('500');

      expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries

      // Restore fake timers for next test
      jest.useFakeTimers();
    });

    it('does not retry non-retryable errors', async () => {
      const error = new APIError(400, { type: 'error' }, 'Bad request', new Headers());
      const fn = jest.fn().mockRejectedValue(error);

      const promise = withRetry(fn, { maxRetries: 3 });

      await expect(promise).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('uses exponential backoff', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new APIConnectionError({ message: 'fail' }))
        .mockRejectedValueOnce(new APIConnectionError({ message: 'fail' }))
        .mockResolvedValueOnce('success');

      const promise = withRetry(fn, {
        maxRetries: 3,
        initialDelayMs: 100,
        backoffMultiplier: 2,
        jitter: false,
      });

      // First attempt
      await jest.advanceTimersByTimeAsync(0);

      // First retry after 100ms
      await jest.advanceTimersByTimeAsync(100);

      // Second retry after 200ms (100 * 2)
      await jest.advanceTimersByTimeAsync(200);

      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('respects maxDelayMs cap', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new APIConnectionError({ message: 'fail' }))
        .mockRejectedValueOnce(new APIConnectionError({ message: 'fail' }))
        .mockRejectedValueOnce(new APIConnectionError({ message: 'fail' }))
        .mockResolvedValueOnce('success');

      const promise = withRetry(fn, {
        maxRetries: 4,
        initialDelayMs: 1000,
        maxDelayMs: 2000,
        backoffMultiplier: 10,
        jitter: false,
      });

      // First attempt
      await jest.advanceTimersByTimeAsync(0);
      // 1000ms
      await jest.advanceTimersByTimeAsync(1000);
      // 2000ms (capped, would be 10000)
      await jest.advanceTimersByTimeAsync(2000);
      // 2000ms (capped, would be 100000)
      await jest.advanceTimersByTimeAsync(2000);

      const result = await promise;
      expect(result).toBe('success');
    });
  });
});
