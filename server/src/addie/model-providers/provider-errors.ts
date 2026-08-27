import type { ModelProviderId } from './model-provider.js';

export type ProviderFailureCategory =
  | 'billing_exhausted'
  | 'rate_limited'
  | 'overloaded'
  | 'timeout'
  | 'unavailable'
  | 'authentication'
  | 'invalid_request'
  | 'unknown';

export interface ProviderFailure {
  category: ProviderFailureCategory;
  retryAfterSeconds?: number;
  status?: number;
}

const MAX_RETRY_AFTER_SECONDS = 60 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function statusFromError(error: unknown, depth = 0): number | undefined {
  if (!isRecord(error) || depth > 2) return undefined;
  for (const key of ['status', 'statusCode']) {
    const value = error[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return statusFromError(error.cause, depth + 1);
}

function messageFromError(error: unknown, depth = 0): string {
  if (depth > 2) return '';
  if (error instanceof Error) {
    return `${error.message}\n${messageFromError(error.cause, depth + 1)}`;
  }
  if (!isRecord(error)) return typeof error === 'string' ? error : '';
  const ownMessage = stringField(error, 'message') ?? '';
  const body = isRecord(error.error) ? error.error : null;
  const bodyMessage = body ? stringField(body, 'message') ?? '' : '';
  return `${ownMessage}\n${bodyMessage}\n${messageFromError(error.cause, depth + 1)}`;
}

function codeFromError(error: unknown, depth = 0): string[] {
  if (!isRecord(error) || depth > 2) return [];
  const body = isRecord(error.error) ? error.error : null;
  const codes = [
    stringField(error, 'code'),
    stringField(error, 'type'),
    body ? stringField(body, 'code') : undefined,
    body ? stringField(body, 'type') : undefined,
    ...codeFromError(error.cause, depth + 1),
  ];
  return codes.filter((value): value is string => !!value).map(value => value.toLowerCase());
}

function headerValue(error: unknown, name: string, depth = 0): string | undefined {
  if (!isRecord(error) || depth > 2) return undefined;
  const headers = error.headers;
  if (isRecord(headers)) {
    const getter = headers.get;
    if (typeof getter === 'function') {
      const value = getter.call(headers, name);
      if (typeof value === 'string') return value;
    }
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name && typeof value === 'string') return value;
    }
  }
  return headerValue(error.cause, name, depth + 1);
}

/** Parse Retry-After once into bounded whole seconds. */
export function getProviderRetryAfterSeconds(error: unknown, nowMs = Date.now()): number | undefined {
  const value = headerValue(error, 'retry-after')?.trim();
  if (!value) return undefined;

  const numeric = Number(value);
  const seconds = Number.isFinite(numeric)
    ? Math.ceil(numeric)
    : Math.ceil((Date.parse(value) - nowMs) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(MAX_RETRY_AFTER_SECONDS, seconds);
}

export function classifyProviderFailure(
  provider: ModelProviderId,
  error: unknown,
  nowMs = Date.now(),
): ProviderFailure {
  const status = statusFromError(error);
  const retryAfterSeconds = getProviderRetryAfterSeconds(error, nowMs);
  const message = messageFromError(error).toLowerCase();
  const codes = codeFromError(error);
  const hasCode = (...values: string[]) => values.some(value => codes.includes(value));

  const billingExhausted = provider === 'anthropic'
    ? /credit balance is too low|plans?\s*&\s*billing/.test(message)
    : provider === 'openai'
      ? hasCode('insufficient_quota', 'billing_hard_limit_reached')
      : false;
  if (billingExhausted) return { category: 'billing_exhausted', ...(status && { status }) };

  if (status === 429 || hasCode('rate_limit_error', 'rate_limit_exceeded')) {
    return { category: 'rate_limited', ...(retryAfterSeconds !== undefined && { retryAfterSeconds }), ...(status && { status }) };
  }
  if (status === 529 || hasCode('overloaded_error') || /\boverloaded(?:_error)?\b|\bhigh demand\b/.test(message)) {
    return { category: 'overloaded', ...(retryAfterSeconds !== undefined && { retryAfterSeconds }), ...(status && { status }) };
  }
  if (hasCode('timeout', 'request_timeout') || /\b(?:timed? out|timeout)\b/.test(message)) {
    return { category: 'timeout', ...(retryAfterSeconds !== undefined && { retryAfterSeconds }), ...(status && { status }) };
  }
  if (
    (status !== undefined && status >= 500)
    || hasCode('api_error', 'connection_error', 'service_unavailable')
    || /\b(?:connection (?:failed|reset)|service unavailable)\b/.test(message)
  ) {
    return { category: 'unavailable', ...(retryAfterSeconds !== undefined && { retryAfterSeconds }), ...(status && { status }) };
  }
  if (status === 401 || status === 403 || hasCode('authentication_error', 'permission_error')) {
    return { category: 'authentication', ...(status && { status }) };
  }
  if (status === 400 || hasCode('invalid_request_error')) {
    return { category: 'invalid_request', ...(status && { status }) };
  }
  return { category: 'unknown', ...(status && { status }) };
}
