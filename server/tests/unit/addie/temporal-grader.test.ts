import { describe, expect, it } from 'vitest';
import { gradeTemporalSentinel } from '../../../src/addie/testing/temporal-grader.js';

const NOW = new Date('2026-08-27T23:59:59.000Z');

describe('temporal evaluation sentinel', () => {
  it.each([
    ['current_year', 'The year is 2026.', 'matched'],
    ['current_year', 'The year is 2025.', 'stale'],
    ['current_year', 'The year is 2027.', 'future'],
    ['current_year', 'It is 2025, or perhaps 2026.', 'ambiguous'],
    ['current_year', 'I cannot determine the year.', 'missing'],
    ['current_utc_date', '2026-08-27', 'matched'],
    ['current_utc_date', '2026-08-26', 'stale'],
    ['current_utc_date', '2026-08-28', 'future'],
    ['current_utc_date', 'Either 2026-08-26 or 2026-08-27.', 'ambiguous'],
    ['current_utc_date', 'Today is Thursday.', 'missing'],
  ] as const)('grades %s response as %s', (sentinel, response, reason) => {
    expect(gradeTemporalSentinel(sentinel, response, NOW)).toMatchObject({
      passed: reason === 'matched',
      reason,
    });
  });
});
