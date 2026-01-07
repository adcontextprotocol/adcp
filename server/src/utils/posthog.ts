/**
 * PostHog Server-Side Analytics
 *
 * Provides server-side event tracking and error capture.
 * Only initializes if POSTHOG_API_KEY is set.
 *
 * Integrates with the logger to automatically capture all error/fatal logs.
 */

import { PostHog } from 'posthog-node';
import { createLogger, setErrorHook } from '../logger.js';

const logger = createLogger('posthog');

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

// Singleton PostHog client
let posthogClient: PostHog | null = null;

/**
 * Get the PostHog client instance (lazy initialization)
 */
export function getPostHog(): PostHog | null {
  if (!POSTHOG_API_KEY) {
    return null;
  }

  if (!posthogClient) {
    try {
      posthogClient = new PostHog(POSTHOG_API_KEY, {
        host: POSTHOG_HOST,
        // Flush events in batches
        flushAt: 20,
        flushInterval: 10000, // 10 seconds
      });
      logger.info('PostHog client initialized');
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize PostHog client');
      return null;
    }
  }

  return posthogClient;
}

/**
 * Capture a server-side event
 */
export function captureEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>
): void {
  const client = getPostHog();
  if (!client) return;

  client.capture({
    distinctId,
    event,
    properties: {
      ...properties,
      $lib: 'posthog-node',
      source: 'server',
    },
  });
}

/**
 * Capture a server-side exception
 */
export function captureException(
  error: Error,
  distinctId?: string,
  properties?: Record<string, unknown>
): void {
  const client = getPostHog();
  if (!client) return;

  // Use anonymous ID if no user ID provided
  const id = distinctId || 'server-anonymous';

  client.capture({
    distinctId: id,
    event: '$exception',
    properties: {
      $exception_message: error.message,
      $exception_type: error.name,
      $exception_stack_trace_raw: error.stack,
      ...properties,
      $lib: 'posthog-node',
      source: 'server',
    },
  });

  logger.debug({ error: error.message, distinctId: id }, 'Exception captured to PostHog');
}

/**
 * Identify a user with properties
 */
export function identifyUser(
  distinctId: string,
  properties?: Record<string, unknown>
): void {
  const client = getPostHog();
  if (!client) return;

  client.identify({
    distinctId,
    properties,
  });
}

/**
 * Shutdown PostHog client (call on server shutdown)
 */
export async function shutdownPostHog(): Promise<void> {
  if (posthogClient) {
    await posthogClient.shutdown();
    posthogClient = null;
    logger.info('PostHog client shut down');
  }
}

// Rate limiting for error capture to prevent flooding PostHog
const ERROR_RATE_LIMIT_MS = 100; // Min 100ms between errors
const ERROR_DEDUP_WINDOW_MS = 5000; // Dedupe same error within 5 seconds
let lastErrorTime = 0;
const recentErrors = new Map<string, number>(); // message -> timestamp

/**
 * Initialize PostHog error tracking integration with the logger.
 * Call this once at server startup to capture all logger.error() and logger.fatal() calls.
 *
 * Includes rate limiting to prevent flooding PostHog during error storms.
 *
 * @returns true if PostHog error tracking was enabled, false if POSTHOG_API_KEY is not set
 */
export function initPostHogErrorTracking(): boolean {
  if (!POSTHOG_API_KEY) {
    return false;
  }

  // Ensure client is initialized
  getPostHog();

  // Set up the error hook in the logger
  setErrorHook((message, error, context) => {
    const client = getPostHog();
    if (!client) return;

    const now = Date.now();

    // Rate limit: skip if too soon after last error
    if (now - lastErrorTime < ERROR_RATE_LIMIT_MS) {
      return;
    }

    // Dedupe: skip if same error message within window
    const errorKey = `${message}:${error?.name || 'Error'}`;
    const lastSeen = recentErrors.get(errorKey);
    if (lastSeen && now - lastSeen < ERROR_DEDUP_WINDOW_MS) {
      return;
    }

    lastErrorTime = now;
    recentErrors.set(errorKey, now);

    // Clean up old entries periodically
    if (recentErrors.size > 100) {
      const cutoff = now - ERROR_DEDUP_WINDOW_MS;
      for (const [key, time] of recentErrors) {
        if (time < cutoff) recentErrors.delete(key);
      }
    }

    // Extract module from context if available (set by createLogger)
    const module = (context?.module as string) || 'unknown';

    client.capture({
      distinctId: 'server-logs',
      event: '$exception',
      properties: {
        $exception_message: message,
        $exception_type: error?.name || 'Error',
        $exception_stack_trace_raw: error?.stack,
        // Include context for debugging
        module,
        ...context,
        $lib: 'posthog-node',
        source: 'server-logger',
      },
    });
  });

  logger.info('PostHog error tracking initialized - all logger.error() calls will be captured');
  return true;
}
