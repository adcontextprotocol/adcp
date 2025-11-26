/**
 * Structured logging with Pino
 *
 * Provides a centralized logger instance with appropriate configuration
 * for development and production environments.
 */

import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),

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
