/**
 * Retry utilities for one-shot Anthropic API calls.
 *
 * This module deliberately does not expose a streaming retry wrapper. Addie
 * owns provider-stream attempt buffering in `claude-client.ts`, while delivery
 * adapters own interrupted-turn persistence and explicit user continuation.
 * A generic async-generator wrapper cannot know whether a yielded value or
 * tool action made restarting the generator unsafe.
 */

import { APIError, APIConnectionError } from '@anthropic-ai/sdk';
import { logger } from '../logger.js';
import {
  classifyProviderFailure,
  getProviderRetryAfterSeconds,
} from '../addie/model-providers/provider-errors.js';

/**
 * Error thrown when all retry attempts have been exhausted
 */
export class RetriesExhaustedError extends Error {
  /** The underlying error that caused the retries */
  readonly cause: unknown;
  /** Number of attempts made */
  readonly attempts: number;
  /** User-friendly reason for the failure */
  readonly reason: string;
  /** Provider-supplied recovery delay, normalized to whole seconds. */
  readonly retryAfterSeconds?: number;

  constructor(cause: unknown, attempts: number) {
    const errorMsg = cause instanceof Error ? cause.message : String(cause);
    const reason = errorMsg.includes('overloaded') ? 'The AI service is currently experiencing high demand' :
                   errorMsg.includes('rate') ? 'Rate limit exceeded' :
                   errorMsg.includes('timeout') ? 'Request timed out' :
                   'The AI service is temporarily unavailable';

    super(`Retries exhausted after ${attempts} attempts: ${reason}`);
    this.name = 'RetriesExhaustedError';
    this.cause = cause;
    this.attempts = attempts;
    this.reason = reason;
    this.retryAfterSeconds = getProviderRetryAfterSeconds(cause);
  }
}

/**
 * Check if an error is a RetriesExhaustedError
 */
export function isRetriesExhaustedError(error: unknown): error is RetriesExhaustedError {
  return error instanceof RetriesExhaustedError;
}

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

function getAnthropicErrorType(errorBody: unknown): string | undefined {
  if (typeof errorBody !== 'object' || errorBody === null) {
    return undefined;
  }

  const body = errorBody as { type?: unknown; error?: { type?: unknown } };
  if (body.type === 'error' && typeof body.error?.type === 'string') {
    return body.error.type;
  }

  if (typeof body.type === 'string') {
    return body.type;
  }

  if (typeof body.error?.type === 'string') {
    return body.error.type;
  }

  return undefined;
}

function getAnthropicErrorTypeFromMessage(message: string): string | undefined {
  const jsonStart = message.indexOf('{');
  if (jsonStart === -1) return undefined;

  try {
    return getAnthropicErrorType(JSON.parse(message.slice(jsonStart)));
  } catch {
    return undefined;
  }
}

function isRetryableAnthropicErrorType(errorType: string | undefined): boolean {
  return errorType === 'overloaded_error' ||
    errorType === 'api_error' ||
    errorType === 'rate_limit_error';
}

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

    // Check error body for retryable error types.
    // Streaming errors deliver errors in the SSE stream body (HTTP 200),
    // so error.status is undefined — we must check the error body.
    const errorType = getAnthropicErrorType(error.error);
    if (isRetryableAnthropicErrorType(errorType)) {
      return true;
    }
  }

  // Check error message for overloaded indication
  if (error instanceof Error) {
    if (error.message.includes('overloaded_error')) {
      return true;
    }
    if (isRetryableAnthropicErrorType(getAnthropicErrorTypeFromMessage(error.message))) {
      return true;
    }
  }

  const category = classifyProviderFailure('anthropic', error).category;
  if (category === 'rate_limited' || category === 'overloaded' || category === 'timeout' || category === 'unavailable') {
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
 * Execute one promise-returning provider request with retry on transient errors.
 *
 * The callback must describe a request that is safe to submit again before it
 * resolves. It must not expose partial output or perform an irreversible tool
 * action. Streaming calls use Addie's buffered retry loop instead, because it
 * can distinguish an unexposed provider attempt from an interrupted logical
 * turn and cannot be safely merged into this helper.
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
      const retryAfterSeconds = getProviderRetryAfterSeconds(error);
      const providerDelayMs = retryAfterSeconds === undefined ? 0 : retryAfterSeconds * 1000;
      if (providerDelayMs > finalConfig.maxDelayMs) {
        logger.warn(
          {
            attempt,
            maxRetries: finalConfig.maxRetries,
            retryAfterSeconds,
            operation: operationName,
          },
          'Anthropic API: Retry-After exceeds request retry budget; deferring recovery',
        );
        throw new RetriesExhaustedError(error, attempt);
      }
      const scheduledDelayMs = Math.max(delayMs, providerDelayMs);

      logger.warn(
        {
          attempt,
          maxRetries: finalConfig.maxRetries,
          delayMs: Math.round(scheduledDelayMs),
          retryAfterSeconds,
          error: error instanceof Error ? error.message : String(error),
          operation: operationName,
        },
        `Anthropic API: Retryable error, waiting before retry ${attempt}/${finalConfig.maxRetries}`
      );

      await sleep(scheduledDelayMs);
    }
  }

  // All retries exhausted
  const totalAttempts = finalConfig.maxRetries + 1;
  logger.error(
    {
      totalAttempts,
      error: lastError instanceof Error ? lastError.message : String(lastError),
      operation: operationName,
    },
    'Anthropic API: All retry attempts exhausted'
  );

  throw new RetriesExhaustedError(lastError, totalAttempts);
}
