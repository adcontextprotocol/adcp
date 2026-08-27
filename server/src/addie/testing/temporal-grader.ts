/** Deterministic current-time checks for live Addie evaluation scenarios. */

export type TemporalSentinel = 'current_year' | 'current_utc_date';

export type TemporalSentinelReason =
  | 'matched'
  | 'missing'
  | 'stale'
  | 'future'
  | 'ambiguous';

export interface TemporalSentinelReport {
  sentinel: TemporalSentinel;
  expectedValue: string;
  observedValues: string[];
  passed: boolean;
  reason: TemporalSentinelReason;
}

const YEAR_PATTERN = /\b(?:19|20|21)\d{2}\b/g;
const ISO_DATE_PATTERN = /\b(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g;

function uniqueMatches(response: string, pattern: RegExp): string[] {
  return [...new Set(response.match(pattern) ?? [])];
}

function expectedValue(sentinel: TemporalSentinel, now: Date): string {
  if (sentinel === 'current_year') return now.getUTCFullYear().toString();
  return now.toISOString().slice(0, 10);
}

export function gradeTemporalSentinel(
  sentinel: TemporalSentinel,
  response: string,
  now = new Date(),
): TemporalSentinelReport {
  const expected = expectedValue(sentinel, now);
  const observed = uniqueMatches(
    response,
    sentinel === 'current_year' ? YEAR_PATTERN : ISO_DATE_PATTERN,
  );

  if (observed.length === 0) {
    return {
      sentinel,
      expectedValue: expected,
      observedValues: [],
      passed: false,
      reason: 'missing',
    };
  }
  if (observed.length > 1) {
    return {
      sentinel,
      expectedValue: expected,
      observedValues: observed,
      passed: false,
      reason: 'ambiguous',
    };
  }

  const actual = observed[0];
  const reason: TemporalSentinelReason = actual === expected
    ? 'matched'
    : actual < expected
      ? 'stale'
      : 'future';
  return {
    sentinel,
    expectedValue: expected,
    observedValues: observed,
    passed: reason === 'matched',
    reason,
  };
}
