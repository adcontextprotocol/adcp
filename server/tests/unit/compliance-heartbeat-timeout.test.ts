import { describe, expect, it } from 'vitest';
import {
  describeHeartbeatTimeout,
  heartbeatTimeoutHeadline,
  HEARTBEAT_TIMEOUT_STREAK_WINDOW,
  isHeartbeatTimeoutRun,
  parseStoryboardCoverage,
  projectHeartbeatTimeout,
  type HeartbeatTimeoutRun,
} from '../../src/compliance/heartbeat-timeout.js';

const COVERAGE_MESSAGE =
  'Compliance timeout budget of 600000ms was reached. Stopped starting new storyboards after 68/74 selected storyboard(s).';

const timedOutRun = (overrides: Partial<HeartbeatTimeoutRun> = {}): HeartbeatTimeoutRun => ({
  id: '123e4567-e89b-42d3-a456-426614174000',
  tested_at: new Date('2026-10-01T10:07:00Z'),
  completeness: 'timed_out',
  total_duration_ms: 654_321,
  provenance_json: { timeout_ms: 600_000 },
  observations_json: [{ category: 'performance', severity: 'warning', message: COVERAGE_MESSAGE }],
  ...overrides,
});

describe('parseStoryboardCoverage', () => {
  it('reads the runner coverage observation', () => {
    expect(parseStoryboardCoverage([{ message: COVERAGE_MESSAGE }]))
      .toEqual({ completed: 68, total: 74, message: COVERAGE_MESSAGE });
  });

  it('rejects impossible counts instead of rendering them', () => {
    const message = 'Stopped starting new storyboards after 80/74 selected storyboard(s).';
    expect(parseStoryboardCoverage([{ message }]))
      .toEqual({ completed: null, total: null, message });
  });

  it('tolerates missing, non-array, and non-string observations', () => {
    expect(parseStoryboardCoverage(undefined).completed).toBeNull();
    expect(parseStoryboardCoverage('not an array').completed).toBeNull();
    expect(parseStoryboardCoverage([null, 7, { message: 12 }, { other: 'x' }]).completed).toBeNull();
  });
});

describe('isHeartbeatTimeoutRun', () => {
  it('counts a hard-deadline abort, which the worker records not_completed', () => {
    expect(isHeartbeatTimeoutRun({
      completeness: 'not_completed',
      headline: heartbeatTimeoutHeadline(600_000),
    })).toBe(true);
  });

  it('does not count other incomplete runs', () => {
    expect(isHeartbeatTimeoutRun({ completeness: 'not_completed', headline: 'Unreachable: ECONNRESET' })).toBe(false);
    expect(isHeartbeatTimeoutRun({ completeness: 'not_completed', headline: null })).toBe(false);
    expect(isHeartbeatTimeoutRun({ completeness: 'complete', headline: 'All good' })).toBe(false);
  });
});

describe('projectHeartbeatTimeout', () => {
  it('surfaces when, how long, and how far the timed-out heartbeat got', () => {
    const state = projectHeartbeatTimeout([timedOutRun()], {
      publishedAt: new Date('2026-09-20T08:00:00Z'),
    });

    expect(state).toMatchObject({
      run_id: '123e4567-e89b-42d3-a456-426614174000',
      timed_out_at: '2026-10-01T10:07:00.000Z',
      duration_ms: 654_321,
      timeout_ms: 600_000,
      storyboards_completed: 68,
      storyboards_total: 74,
      consecutive: 1,
      consecutive_capped: false,
      published_at: '2026-09-20T08:00:00.000Z',
    });
    expect(state?.summary).toBe(
      'Last heartbeat timed out at 2026-10-01T10:07:00.000Z after 654s of its 600s budget'
      + ' (68/74 storyboards completed). The published compliance result was not updated.',
    );
  });

  it('counts only the leading streak of timed-out heartbeats', () => {
    const state = projectHeartbeatTimeout([
      timedOutRun(),
      timedOutRun({ completeness: 'not_completed', headline: heartbeatTimeoutHeadline(600_000) }),
      timedOutRun(),
      { id: 'd', tested_at: new Date('2026-09-01T00:00:00Z'), completeness: 'complete' },
      timedOutRun(),
    ], { windowLimit: HEARTBEAT_TIMEOUT_STREAK_WINDOW });

    expect(state).toMatchObject({ consecutive: 3, consecutive_capped: false });
    expect(state?.summary).toContain('3 heartbeats in a row have timed out.');
  });

  it('says "at least" once the streak fills the lookback window', () => {
    const state = projectHeartbeatTimeout(
      Array.from({ length: 4 }, () => timedOutRun()),
      { windowLimit: 4 },
    );

    expect(state).toMatchObject({ consecutive: 4, consecutive_capped: true });
    expect(state?.summary).toContain('at least 4 heartbeats in a row have timed out.');
  });

  it('clears as soon as the newest heartbeat is not a timeout', () => {
    expect(projectHeartbeatTimeout([
      { id: 'newest', tested_at: new Date('2026-10-02T00:00:00Z'), completeness: 'complete' },
      timedOutRun(),
    ])).toBeNull();
    expect(projectHeartbeatTimeout([
      { id: 'newest', tested_at: new Date('2026-10-02T00:00:00Z'), completeness: 'not_completed', headline: 'Unreachable: nope' },
      timedOutRun(),
    ])).toBeNull();
    expect(projectHeartbeatTimeout([])).toBeNull();
  });

  it('drops unusable timestamps, durations, and budgets rather than rendering NaN', () => {
    const state = projectHeartbeatTimeout([timedOutRun({
      total_duration_ms: null,
      provenance_json: null,
      observations_json: [],
    })]);

    expect(state).toMatchObject({ duration_ms: null, timeout_ms: null, storyboards_completed: null });
    expect(state?.summary).toBe(
      'Last heartbeat timed out at 2026-10-01T10:07:00.000Z. The published compliance result was not updated.',
    );
    expect(state?.summary).not.toContain('NaN');
    expect(projectHeartbeatTimeout([timedOutRun({ tested_at: 'not-a-date' })])).toBeNull();
  });
});

describe('describeHeartbeatTimeout', () => {
  it('reports the budget alone when the runner gave no duration', () => {
    expect(describeHeartbeatTimeout({
      timed_out_at: '2026-10-01T10:07:00.000Z',
      duration_ms: null,
      timeout_ms: 1_800_000,
      storyboards_completed: null,
      storyboards_total: null,
      consecutive: 1,
    })).toBe(
      'Last heartbeat timed out at 2026-10-01T10:07:00.000Z at its 1800s budget.'
      + ' The published compliance result was not updated.',
    );
  });
});
