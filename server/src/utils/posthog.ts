/**
 * PostHog Server-Side Analytics
 *
 * Provides server-side event tracking and error capture.
 * Only initializes if POSTHOG_API_KEY is set.
 */

import { PostHog } from 'posthog-node';
import { createLogger } from '../logger.js';

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
    posthogClient = new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_HOST,
      // Flush events in batches
      flushAt: 20,
      flushInterval: 10000, // 10 seconds
    });
    logger.info('PostHog client initialized');
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
