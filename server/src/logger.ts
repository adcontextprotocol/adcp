/**
 * Structured logging with Pino
 *
 * Provides a centralized logger instance with appropriate configuration
 * for development and production environments.
 *
 * Supports hooks for sending logs to external services:
 * - Error hook: Sends error/fatal logs to PostHog exceptions
 * - Log hook: Sends all logs to PostHog via OpenTelemetry
 */

import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Error hook type - called when logger.error() or logger.fatal() is invoked.
 * Set via setErrorHook() to avoid circular dependencies with PostHog.
 */
type ErrorHook = (
  message: string,
  error?: Error,
  context?: Record<string, unknown>
) => void;

/**
 * Log hook type - called for all log levels.
 * Set via setLogHook() for OpenTelemetry integration.
 */
type LogHook = (
  level: number,
  message: string,
  attributes: Record<string, unknown>
) => void;

let errorHook: ErrorHook | null = null;
let logHook: LogHook | null = null;

/**
 * Set the error hook for external error reporting.
 * Call this after PostHog is initialized to send errors there.
 */
export function setErrorHook(hook: ErrorHook): void {
  errorHook = hook;
}

/**
 * Set the log hook for OpenTelemetry logging.
 * Call this after OpenTelemetry is initialized.
 */
export function setLogHook(hook: LogHook): void {
  logHook = hook;
}

// Pino hooks to capture logs for external reporting
const hooks: pino.LoggerOptions['hooks'] = {
  logMethod(inputArgs, method, level) {
    // Early return if no hooks are set to avoid unnecessary processing
    const needsLogHook = logHook !== null;
    const needsErrorHook = level >= 50 && errorHook !== null;
    if (!needsLogHook && !needsErrorHook) {
      return method.apply(this, inputArgs);
    }

    const args = inputArgs as unknown[];
    let message = '';
    let error: Error | undefined;
    let context: Record<string, unknown> = {};

    // Parse Pino's flexible argument format
    for (const arg of args) {
      if (arg instanceof Error) {
        error = arg;
      } else if (typeof arg === 'string') {
        message = arg;
      } else if (typeof arg === 'object' && arg !== null) {
        // Context object - extract error if present
        const obj = arg as Record<string, unknown>;
        if (obj.err instanceof Error) {
          error = obj.err;
        } else if (obj.error instanceof Error) {
          error = obj.error;
        }
        // Copy other context (excluding the error we already extracted)
        const { err, error: _error, ...rest } = obj;
        context = { ...context, ...rest };
      }
    }

    // Send all logs to OpenTelemetry if hook is set
    if (logHook) {
      try {
        const attributes: Record<string, unknown> = { ...context };
        if (error) {
          attributes.err = error;
        }
        logHook(level, message || error?.message || '', attributes);
      } catch {
        // Silently ignore hook errors to prevent logging loops
      }
    }

    // Send error/fatal logs to PostHog error tracking
    if (level >= 50 && errorHook) {
      // If no Error object but we have a message, create one for stack trace
      if (!error && message) {
        error = new Error(message);
      }

      try {
        errorHook(message || error?.message || 'Unknown error', error, context);
      } catch {
        // Silently ignore hook errors to prevent logging loops
      }
    }

    // Always call the original method
    return method.apply(this, inputArgs);
  },
};

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),

  hooks,

  // Use pino-pretty in development for human-readable logs
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,

  // Redact sensitive fields from logs
  redact: {
    paths: [
      'password',
      'token',
      'accessToken',
      'access_token',
      'refreshToken',
      'refresh_token',
      'apiKey',
      'api_key',
      'secret',
      'authorization',
      'cookie',
      'sessionData',
      'sealedSession',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
    ],
    censor: '[REDACTED]',
  },

  // Serialize error objects properly
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

/**
 * Create a child logger with specific context
 */
export function createLogger(context: string | Record<string, unknown>) {
  const bindings = typeof context === 'string' ? { module: context } : context;
  return logger.child(bindings);
}

/**
 * Log levels guide:
 *
 * - trace: Very detailed, low-level information (usually disabled)
 * - debug: Debugging information (enabled in development)
 * - info: Normal operation messages (default in production)
 * - warn: Warning messages (potential issues)
 * - error: Error messages (operation failed but app continues)
 * - fatal: Critical errors (app cannot continue)
 */
