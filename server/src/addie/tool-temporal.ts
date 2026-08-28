const RFC3339_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export type ZonedTimestampResult =
  | { ok: true; date: Date }
  | { ok: false; error: string };

export function isValidIanaTimeZone(timeZone: string): boolean {
  if (timeZone !== 'UTC' && !timeZone.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function offsetAtInstant(date: Date, timeZone: string): string | null {
  try {
    const value = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value;
    if (value === 'GMT') return '+00:00';
    return value?.match(/^GMT([+-]\d{2}:\d{2})$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse an RFC 3339 instant and verify that its explicit offset agrees with
 * the supplied IANA timezone at that instant. This rejects ambiguous,
 * nonexistent, and server-timezone-dependent local timestamps before a tool
 * performs a mutation.
 */
export function parseZonedTimestamp(value: unknown, timeZone: string): ZonedTimestampResult {
  const match = typeof value === 'string' ? value.match(RFC3339_DATE_TIME_RE) : null;
  if (!match) {
    return {
      ok: false,
      error: 'must be an RFC 3339 timestamp with an explicit Z or numeric offset (for example, 2026-01-15T14:00:00-05:00)',
    };
  }
  if (!isValidIanaTimeZone(timeZone)) {
    return {
      ok: false,
      error: `timezone must be a valid IANA timezone (received "${timeZone}")`,
    };
  }

  const [, year, month, day, hour, minute, second] = match;
  const calendarCheck = new Date(0);
  calendarCheck.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  calendarCheck.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  if (
    calendarCheck.getUTCFullYear() !== Number(year)
    || calendarCheck.getUTCMonth() !== Number(month) - 1
    || calendarCheck.getUTCDate() !== Number(day)
    || calendarCheck.getUTCHours() !== Number(hour)
    || calendarCheck.getUTCMinutes() !== Number(minute)
    || calendarCheck.getUTCSeconds() !== Number(second)
  ) {
    return { ok: false, error: 'must contain a valid calendar date and time' };
  }

  const date = new Date(match[0]);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: 'must be a valid RFC 3339 timestamp' };
  }

  const suppliedOffset = match[7] === 'Z' ? '+00:00' : match[7];
  const expectedOffset = offsetAtInstant(date, timeZone);
  if (!expectedOffset || suppliedOffset !== expectedOffset) {
    return {
      ok: false,
      error: `offset ${suppliedOffset} does not match ${timeZone} at that instant${expectedOffset ? ` (expected ${expectedOffset})` : ''}`,
    };
  }

  return { ok: true, date };
}

/** Format a dated tool record with both human-readable and machine timestamps. */
export function formatZonedTimestamp(value: Date | string, timeZone?: string | null): string {
  const date = value instanceof Date ? value : new Date(value);
  const effectiveTimeZone = timeZone && isValidIanaTimeZone(timeZone) ? timeZone : 'UTC';
  const display = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: effectiveTimeZone,
    timeZoneName: 'short',
  }).format(date);
  return `${display} [instant: ${date.toISOString()}; time_zone: ${effectiveTimeZone}]`;
}

export function formatUtcTimestamp(value: Date | string): string {
  return formatZonedTimestamp(value, 'UTC');
}
