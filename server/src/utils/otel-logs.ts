/**
 * OpenTelemetry Logs Integration for PostHog
 *
 * Sends structured logs to PostHog via OTLP HTTP endpoint.
 * Integrates with Pino logger via a custom hook.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

// Read version from package.json (works in all environments, not just npm scripts)
function getPackageVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = join(__dirname, '../../package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Map Pino log levels to OpenTelemetry severity
const PINO_TO_OTEL_SEVERITY: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE, // trace
  20: SeverityNumber.DEBUG, // debug
  30: SeverityNumber.INFO, // info
  40: SeverityNumber.WARN, // warn
  50: SeverityNumber.ERROR, // error
  60: SeverityNumber.FATAL, // fatal
};

const PINO_LEVEL_NAMES: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

let otelLogger: ReturnType<typeof logs.getLogger> | null = null;
let loggerProvider: LoggerProvider | null = null;

/**
 * Initialize OpenTelemetry logging for PostHog.
 * Call this once at server startup.
 *
 * @returns true if initialized successfully, false if POSTHOG_API_KEY is not set
 */
export function initOtelLogs(): boolean {
  if (!POSTHOG_API_KEY) {
    console.log('[otel-logs] POSTHOG_API_KEY not set, skipping OpenTelemetry logs setup');
    return false;
  }

  // Create resource with service information
  const serviceName = process.env.OTEL_SERVICE_NAME || 'aao-server';
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: getPackageVersion(),
    'deployment.environment': process.env.NODE_ENV || 'development',
  });

  // Configure OTLP exporter for PostHog
  const exporter = new OTLPLogExporter({
    url: `${POSTHOG_HOST}/v1/logs`,
    headers: {
      Authorization: `Bearer ${POSTHOG_API_KEY}`,
    },
  });

  // Create batch processor for performance
  const processor = new BatchLogRecordProcessor(exporter, {
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
    scheduledDelayMillis: 5000,
  });

  // Create logger provider with resource and processor
  loggerProvider = new LoggerProvider({
    resource,
    processors: [processor],
  });

  // Register as global provider
  logs.setGlobalLoggerProvider(loggerProvider);

  // Get logger instance
  otelLogger = logs.getLogger('aao-server');

  console.log('[otel-logs] OpenTelemetry logging initialized for PostHog');
  return true;
}

// Minimum log level to send to PostHog (30 = info, 40 = warn, 50 = error)
// Default to info (30) to capture operational logs, but configurable via env var
const MIN_LOG_LEVEL = parseInt(process.env.OTEL_MIN_LOG_LEVEL || '30', 10);

/**
 * Emit a log record to PostHog via OpenTelemetry.
 * Called by the Pino hook for each log entry.
 * Only sends logs at or above MIN_LOG_LEVEL to control volume.
 */
export function emitLog(
  level: number,
  message: string,
  attributes: Record<string, unknown> = {}
): void {
  if (!otelLogger) return;

  // Filter out logs below minimum level to control volume
  if (level < MIN_LOG_LEVEL) return;

  const severityNumber = PINO_TO_OTEL_SEVERITY[level] || SeverityNumber.INFO;
  const severityText = PINO_LEVEL_NAMES[level] || 'INFO';

  // Clean attributes - remove pino internal fields and convert to string/number/boolean
  const cleanAttributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    // Skip pino internal fields
    if (['level', 'time', 'pid', 'hostname', 'msg'].includes(key)) continue;

    // Convert to primitive types
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      cleanAttributes[key] = value;
    } else if (value instanceof Error) {
      cleanAttributes[`${key}.message`] = value.message;
      cleanAttributes[`${key}.name`] = value.name;
      if (value.stack) {
        cleanAttributes[`${key}.stack`] = value.stack;
      }
    } else if (value !== null && value !== undefined) {
      cleanAttributes[key] = JSON.stringify(value);
    }
  }

  otelLogger.emit({
    severityNumber,
    severityText,
    body: message,
    attributes: cleanAttributes,
  });
}

/**
 * Shutdown OpenTelemetry logging gracefully.
 * Call this on server shutdown.
 */
export async function shutdownOtelLogs(): Promise<void> {
  if (loggerProvider) {
    await loggerProvider.shutdown();
    loggerProvider = null;
    otelLogger = null;
    console.log('[otel-logs] OpenTelemetry logging shut down');
  }
}
