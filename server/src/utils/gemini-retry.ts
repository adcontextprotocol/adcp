/**
 * Retry utilities for Google Gemini API calls
 *
 * Handles transient errors (503 Service Unavailable, 429 rate limits)
 * with exponential backoff.
 */

import { createLogger } from '../logger.js';

const logger = createLogger('gemini-retry');

export interface GeminiRetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

const DEFAULT_CONFIG: Required<GeminiRetryConfig> = {
  maxRetries: 3,
  initialDelayMs: 2000,
  maxDelayMs: 15000,
  backoffMultiplier: 2,
};

function isRetryableGeminiError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  return (
    msg.includes('503') ||
    msg.includes('Service Unavailable') ||
    msg.includes('429') ||
    msg.includes('Resource has been exhausted') ||
    msg.includes('high demand') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('fetch failed') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('aborted') ||
    error.name === 'AbortError'
  );
}

function calculateDelay(attempt: number, config: Required<GeminiRetryConfig>): number {
  const base = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
  const capped = Math.min(base, config.maxDelayMs);
  // Add jitter of +/- 25%
  return capped + (Math.random() * 2 - 1) * capped * 0.25;
}

/**
 * Execute an async function with retry on transient Gemini errors.
 */
export async function withGeminiRetry<T>(
  fn: () => Promise<T>,
  config?: GeminiRetryConfig,
  operationName?: string,
): Promise<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lastError: unknown;

  for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt > cfg.maxRetries) {
        break;
      }

      if (!isRetryableGeminiError(error)) {
        throw error;
      }

      const delayMs = calculateDelay(attempt, cfg);
      logger.warn(
        {
          attempt,
          maxRetries: cfg.maxRetries,
          delayMs: Math.round(delayMs),
          error: error instanceof Error ? error.message.slice(0, 200) : String(error),
          operation: operationName,
        },
        `Gemini API: Retryable error, waiting before retry ${attempt}/${cfg.maxRetries}`,
      );

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  const totalAttempts = cfg.maxRetries + 1;
  logger.error(
    {
      totalAttempts,
      error: lastError instanceof Error ? lastError.message.slice(0, 200) : String(lastError),
      operation: operationName,
    },
    'Gemini API: All retry attempts exhausted',
  );

  throw lastError;
}
