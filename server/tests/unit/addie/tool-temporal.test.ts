import { describe, expect, it } from 'vitest';
import {
  formatUtcTimestamp,
  formatZonedTimestamp,
  parseZonedTimestamp,
} from '../../../src/addie/tool-temporal.js';

describe('parseZonedTimestamp', () => {
  it('accepts an explicit offset that matches the IANA timezone', () => {
    const result = parseZonedTimestamp('2026-01-15T14:00:00-05:00', 'America/New_York');

    expect(result).toEqual({ ok: true, date: new Date('2026-01-15T19:00:00.000Z') });
  });

  it('accepts UTC timestamps for UTC', () => {
    expect(parseZonedTimestamp('2026-01-15T19:00:00Z', 'UTC').ok).toBe(true);
  });

  it('rejects timestamps without an offset', () => {
    const result = parseZonedTimestamp('2026-01-15T14:00:00', 'America/New_York');

    expect(result).toEqual(expect.objectContaining({ ok: false }));
  });

  it('rejects calendar dates that JavaScript would otherwise roll forward', () => {
    const result = parseZonedTimestamp('2026-02-30T12:00:00Z', 'UTC');

    expect(result).toEqual(expect.objectContaining({ ok: false }));
  });

  it('rejects an offset that disagrees across a DST boundary', () => {
    const before = parseZonedTimestamp('2026-03-08T01:30:00-05:00', 'America/New_York');
    const nonexistent = parseZonedTimestamp('2026-03-08T02:30:00-05:00', 'America/New_York');
    const after = parseZonedTimestamp('2026-03-08T03:30:00-04:00', 'America/New_York');

    expect(before.ok).toBe(true);
    expect(nonexistent).toEqual(expect.objectContaining({ ok: false }));
    expect(after.ok).toBe(true);
  });

  it('distinguishes both offsets during the repeated fall-back hour', () => {
    expect(parseZonedTimestamp('2026-11-01T01:30:00-04:00', 'America/New_York').ok).toBe(true);
    expect(parseZonedTimestamp('2026-11-01T01:30:00-05:00', 'America/New_York').ok).toBe(true);
  });

  it('rejects invalid IANA timezones', () => {
    const result = parseZonedTimestamp('2026-01-15T14:00:00-05:00', 'EST');

    expect(result).toEqual(expect.objectContaining({ ok: false }));
  });
});

describe('tool timestamp formatting', () => {
  it('preserves the instant and IANA timezone in dated records', () => {
    expect(formatZonedTimestamp('2026-01-15T19:00:00.000Z', 'America/New_York')).toContain(
      '[instant: 2026-01-15T19:00:00.000Z; time_zone: America/New_York]',
    );
  });

  it('labels UTC timestamps explicitly', () => {
    expect(formatUtcTimestamp('2026-01-15T19:00:00.000Z')).toContain(
      '[instant: 2026-01-15T19:00:00.000Z; time_zone: UTC]',
    );
  });
});
