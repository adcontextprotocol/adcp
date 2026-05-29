import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_PROBE_MAX_ATTEMPTS,
  buildUnknownProbeState,
  unknownProbeBackoffDays,
} from '../../src/db/agent-snapshot-db.js';

describe('unknown agent probe backoff', () => {
  it('uses 1/2/4/7-day exponential backoff capped at seven days', () => {
    expect(unknownProbeBackoffDays(1)).toBe(1);
    expect(unknownProbeBackoffDays(2)).toBe(2);
    expect(unknownProbeBackoffDays(3)).toBe(4);
    expect(unknownProbeBackoffDays(4)).toBe(7);
    expect(unknownProbeBackoffDays(8)).toBe(7);
  });

  it('schedules the next retry until the attempt cap is exhausted', () => {
    const now = new Date('2026-05-29T12:00:00.000Z');
    const state = buildUnknownProbeState(2, 'unreachable', now);

    expect(state.attemptCount).toBe(3);
    expect(state.terminalState).toBeNull();
    expect(state.lastAttemptAt).toBe(now);
    expect(state.nextProbeAfter?.toISOString()).toBe('2026-06-02T12:00:00.000Z');
  });

  it('sets a terminal state on the tenth failed or unclassified attempt', () => {
    const now = new Date('2026-05-29T12:00:00.000Z');
    const unreachable = buildUnknownProbeState(UNKNOWN_PROBE_MAX_ATTEMPTS - 1, 'unreachable', now);
    const unclassifiable = buildUnknownProbeState(UNKNOWN_PROBE_MAX_ATTEMPTS - 1, 'unclassifiable', now);

    expect(unreachable.attemptCount).toBe(UNKNOWN_PROBE_MAX_ATTEMPTS);
    expect(unreachable.terminalState).toBe('unreachable');
    expect(unreachable.nextProbeAfter).toBeNull();

    expect(unclassifiable.attemptCount).toBe(UNKNOWN_PROBE_MAX_ATTEMPTS);
    expect(unclassifiable.terminalState).toBe('unclassifiable');
    expect(unclassifiable.nextProbeAfter).toBeNull();
  });
});
