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
  setErrorHook((message, error, context, level) => {
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

    // Fatal-level errors get an immediate Slack notification to ops channel.
    if (level && level >= 60) {
      notifySlackCriticalError(message, error, module);
    }

    // All error+ logs get posted to the #aao-errors channel via notifySystemError.
    // The error-notifier has its own 5-minute per-source throttle.
    if (level && level >= 50) {
      notifyErrorChannel(module, message, error, context);
    }
  });

  logger.info('PostHog error tracking initialized - all logger.error() calls will be captured');
  return true;
}

/**
 * Strip connection strings, credentials, and other secrets from error messages
 * before forwarding to Slack.
 */
function sanitizeForSlack(msg: string): string {
  return msg
    .replace(/\b\w+:\/\/[^\s]+@[^\s]+/g, '[REDACTED_URL]')
    .replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/\b(sk|pk|api[_-]?key|secret|token)[_-]?\w*[=:]\s*\S+/gi, '$1=[REDACTED]');
}

/**
 * Bridge logger.error() to the #aao-errors Slack channel via notifySystemError.
 * Uses dynamic import to avoid circular dependencies.
 * Fire-and-forget — failures are silently ignored.
 *
 * Reentrancy guard prevents infinite loops: if sendChannelMessage fails and
 * calls logger.error, the hook would fire again. The guard breaks the cycle.
 */
let notifyingErrorChannel = false;

function notifyErrorChannel(module: string, message: string, error?: Error, context?: Record<string, unknown>): void {
  if (notifyingErrorChannel) return;
  notifyingErrorChannel = true;

  import('../addie/error-notifier.js')
    .then(({ notifySystemError }) => {
      const errorDetail = error?.message && error.message !== message
        ? sanitizeForSlack(`${message}: ${error.message}`)
        : sanitizeForSlack(message);
      const fields = formatContextForSlack(context);
      const stack = error?.stack ? `\n\`\`\`${sanitizeForSlack(error.stack.slice(0, 500))}\`\`\`` : '';
      notifySystemError({
        source: module || 'unknown',
        errorMessage: errorDetail + fields + stack,
      });
    })
    .catch(() => {})
    .finally(() => { notifyingErrorChannel = false; });
}

const SLACK_CONTEXT_DROP_KEYS = new Set(['module', 'processRole', 'pid', 'hostname', 'time', 'level', 'msg']);
const SLACK_CONTEXT_SENSITIVE = /password|token|secret|apikey|api_key|authorization|credential|cookie|session/i;

/**
 * Render structured-log context fields under the error message so Slack
 * readers see what the PostHog event captures (status codes, domains, IDs,
 * resource paths). Drops noisy keys, redacts likely secrets, truncates.
 */
function formatContextForSlack(context?: Record<string, unknown>): string {
  if (!context) return '';
  const lines: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (SLACK_CONTEXT_DROP_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (SLACK_CONTEXT_SENSITIVE.test(key)) {
      lines.push(`• \`${key}\`: [redacted]`);
      continue;
    }
    let rendered: string;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      rendered = String(value);
    } else {
      try {
        rendered = JSON.stringify(value);
      } catch {
        rendered = '[unserializable]';
      }
    }
    if (rendered.length > 200) rendered = rendered.slice(0, 197) + '...';
    lines.push(`• \`${key}\`: ${sanitizeForSlack(rendered)}`);
  }
  if (lines.length === 0) return '';
  return '\n' + lines.join('\n');
}

/**
 * Send a Slack notification for fatal-level errors.
 * Uses the Slack Web API (chat.postMessage) via Addie's bot token, posting
 * to the channel configured in OPS_ALERT_CHANNEL_ID.
 * Fire-and-forget — failures are silently ignored to avoid loops.
 */
const OPS_ALERT_CHANNEL_ID = process.env.OPS_ALERT_CHANNEL_ID;

let notifyingCriticalError = false;

function notifySlackCriticalError(message: string, error?: Error, module?: string): void {
  if (!OPS_ALERT_CHANNEL_ID) return;
  if (notifyingCriticalError) return;
  notifyingCriticalError = true;

  const safeMessage = sanitizeForSlack(message);
  const safeStack = error?.stack ? sanitizeForSlack(error.stack.slice(0, 500)) : '';

  import('../slack/client.js')
    .then(({ sendChannelMessage, isSlackConfigured }) => {
      if (!isSlackConfigured()) return;
      return sendChannelMessage(OPS_ALERT_CHANNEL_ID!, {
        text: `FATAL ERROR on ${process.env.FLY_APP_NAME || 'aao-server'}: ${safeMessage}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                `:rotating_light: *FATAL ERROR* on \`${process.env.FLY_APP_NAME || 'aao-server'}\``,
                module ? `*Module:* \`${module}\`` : '',
                `*Message:* ${safeMessage}`,
                safeStack ? `\`\`\`${safeStack}\`\`\`` : '',
              ].filter(Boolean).join('\n'),
            },
          },
        ],
      });
    })
    .catch(() => {})
    .finally(() => { notifyingCriticalError = false; });
}
