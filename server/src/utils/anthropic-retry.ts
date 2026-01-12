/**
 * Retry utilities for Anthropic API calls
 *
 * Handles transient errors like overloaded_error (529) and connection errors
 * with exponential backoff.
 */

import { APIError, APIConnectionError } from '@anthropic-ai/sdk';
import { logger } from '../logger.js';

/** Configuration for retry behavior */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms before first retry (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in ms between retries (default: 30000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Add random jitter to delays (default: true) */
  jitter?: boolean;
}

const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

/**
 * Check if an error is a retryable Anthropic API error
 *
 * Retryable errors:
 * - overloaded_error (529): API is temporarily overloaded
 * - APIConnectionError: Network issues
 * - InternalServerError (500+): Server-side issues
 * - RateLimitError (429): Rate limited (though SDK may handle this)
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof APIConnectionError) {
    return true;
  }

  if (error instanceof APIError) {
    // Check status code for server errors and overloaded
    const status = error.status;
    if (status !== undefined && status >= 500) {
      return true;
    }

    // Rate limit errors
    if (status === 429) {
      return true;
    }

    // Check error body for overloaded_error type
    // The error object contains the parsed JSON response
    const errorBody = error.error as { type?: string; error?: { type?: string } } | undefined;
    if (errorBody?.type === 'overloaded_error' || errorBody?.error?.type === 'overloaded_error') {
      return true;
    }
  }

  // Check error message for overloaded indication
  if (error instanceof Error && error.message.includes('overloaded_error')) {
    return true;
  }

  return false;
}

/**
 * Calculate delay for a given retry attempt with optional jitter
 */
function calculateDelay(attempt: number, config: Required<RetryConfig>): number {
  const baseDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
  const delay = Math.min(baseDelay, config.maxDelayMs);

  if (config.jitter) {
    // Add random jitter of +/- 25%
    const jitterRange = delay * 0.25;
    return delay + (Math.random() * 2 - 1) * jitterRange;
  }

  return delay;
}

/**
 * Sleep for a given duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute an async function with retry on transient errors
 *
 * @param fn - The async function to execute
 * @param config - Retry configuration
 * @param operationName - Name for logging purposes
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: RetryConfig,
  operationName?: string
): Promise<T> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  let lastError: unknown;

  for (let attempt = 1; attempt <= finalConfig.maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if we've exhausted attempts
      if (attempt > finalConfig.maxRetries) {
        break;
      }

      // Don't retry non-retryable errors
      if (!isRetryableError(error)) {
        throw error;
      }

      const delayMs = calculateDelay(attempt, finalConfig);

      logger.warn(
        {
          attempt,
          maxRetries: finalConfig.maxRetries,
          delayMs: Math.round(delayMs),
          error: error instanceof Error ? error.message : String(error),
          operation: operationName,
        },
        `Anthropic API: Retryable error, waiting before retry ${attempt}/${finalConfig.maxRetries}`
      );

      await sleep(delayMs);
    }
  }

  // All retries exhausted
  logger.error(
    {
      totalAttempts: finalConfig.maxRetries + 1,
      error: lastError instanceof Error ? lastError.message : String(lastError),
      operation: operationName,
    },
    'Anthropic API: All retry attempts exhausted'
  );

  throw lastError;
}

/**
 * Execute a streaming async generator with retry on transient errors
 *
 * Note: This retries the entire stream from the beginning if an error occurs.
 * For streaming APIs, errors typically happen during iteration, so we need
 * to restart the whole stream on retry.
 *
 * @param fn - Factory function that creates the async generator
 * @param config - Retry configuration
 * @param operationName - Name for logging purposes
 * @returns An async generator that yields from the function
 */
export async function* withStreamRetry<T>(
  fn: () => AsyncGenerator<T>,
  config?: RetryConfig,
  operationName?: string
): AsyncGenerator<T> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  let lastError: unknown;

  for (let attempt = 1; attempt <= finalConfig.maxRetries + 1; attempt++) {
    try {
      const generator = fn();
      for await (const item of generator) {
        yield item;
      }
      // Successfully completed
      return;
    } catch (error) {
      lastError = error;

      // Don't retry if we've exhausted attempts
      if (attempt > finalConfig.maxRetries) {
        break;
      }

      // Don't retry non-retryable errors
      if (!isRetryableError(error)) {
        throw error;
      }

      const delayMs = calculateDelay(attempt, finalConfig);

      logger.warn(
        {
          attempt,
          maxRetries: finalConfig.maxRetries,
          delayMs: Math.round(delayMs),
          error: error instanceof Error ? error.message : String(error),
          operation: operationName,
        },
        `Anthropic API Stream: Retryable error, waiting before retry ${attempt}/${finalConfig.maxRetries}`
      );

      await sleep(delayMs);
    }
  }

  // All retries exhausted
  logger.error(
    {
      totalAttempts: finalConfig.maxRetries + 1,
      error: lastError instanceof Error ? lastError.message : String(lastError),
      operation: operationName,
    },
    'Anthropic API Stream: All retry attempts exhausted'
  );

  throw lastError;
}
