import { describe, expect, it } from 'vitest';
import { planGradingProfilePublicEffect } from '../../src/db/verification-profile-db.js';

const now = new Date('2026-09-16T12:00:00.000Z');

describe('grading profile public-effect planning', () => {
  it('revokes an active badge when the retained Strict clock is already expired', () => {
    const result = planGradingProfilePublicEffect({
      selectedProfile: 'spec',
      currentProfile: 'legacy',
      assessmentStatus: 'failing',
      badgeStatus: 'active',
      specFailureSince: new Date('2026-09-13T12:00:00.000Z'),
      now,
    });
    expect(result.publicEffect).toBe('revoke');
    expect(result.graceDeadline?.toISOString()).toBe('2026-09-15T12:00:00.000Z');
  });

  it('shows a fresh Strict deadline when switching an already-degraded Legacy badge', () => {
    const result = planGradingProfilePublicEffect({
      selectedProfile: 'spec',
      currentProfile: 'legacy',
      assessmentStatus: 'failing',
      badgeStatus: 'degraded',
      badgeDegradedAt: new Date('2026-09-10T12:00:00.000Z'),
      specFailureSince: null,
      now,
    });
    expect(result.publicEffect).toBe('regrade');
    expect(result.failureSince).toEqual(now);
    expect(result.graceDeadline?.toISOString()).toBe('2026-09-18T12:00:00.000Z');
  });

  it('gives failing Legacy a fresh clock when leaving Strict', () => {
    const result = planGradingProfilePublicEffect({
      selectedProfile: 'legacy',
      currentProfile: 'spec',
      assessmentStatus: 'failing',
      badgeStatus: 'degraded',
      badgeDegradedAt: new Date('2026-09-10T12:00:00.000Z'),
      specFailureSince: new Date('2026-09-10T12:00:00.000Z'),
      now,
    });
    expect(result.publicEffect).toBe('regrade');
    expect(result.failureSince).toEqual(now);
  });
});
