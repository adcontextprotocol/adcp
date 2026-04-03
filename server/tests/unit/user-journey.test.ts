import { describe, it, expect } from 'vitest';
import { computeUserTier, computeNextSteps, TIER_THRESHOLDS } from '../../src/services/user-journey.js';

describe('computeUserTier', () => {
  it('returns explorer for 0 points', () => {
    const tier = computeUserTier(0);
    expect(tier.tier).toBe('explorer');
    expect(tier.points).toBe(0);
    expect(tier.next_tier).toBe('connector');
    expect(tier.next_tier_at).toBe(50);
    expect(tier.progress_pct).toBe(0);
  });

  it('returns explorer with progress for 25 points', () => {
    const tier = computeUserTier(25);
    expect(tier.tier).toBe('explorer');
    expect(tier.progress_pct).toBe(50);
  });

  it('returns connector at exactly 50 points', () => {
    const tier = computeUserTier(50);
    expect(tier.tier).toBe('connector');
    expect(tier.next_tier).toBe('champion');
    expect(tier.next_tier_at).toBe(200);
    expect(tier.progress_pct).toBe(0);
  });

  it('returns connector with progress at 125 points', () => {
    const tier = computeUserTier(125);
    expect(tier.tier).toBe('connector');
    expect(tier.progress_pct).toBe(50);
  });

  it('returns champion at exactly 200 points', () => {
    const tier = computeUserTier(200);
    expect(tier.tier).toBe('champion');
    expect(tier.next_tier).toBe('pioneer');
    expect(tier.next_tier_at).toBe(500);
  });

  it('returns pioneer at 500 points', () => {
    const tier = computeUserTier(500);
    expect(tier.tier).toBe('pioneer');
    expect(tier.next_tier).toBeNull();
    expect(tier.next_tier_at).toBeNull();
    expect(tier.progress_pct).toBe(100);
  });

  it('returns pioneer at 1500 points', () => {
    const tier = computeUserTier(1500);
    expect(tier.tier).toBe('pioneer');
    expect(tier.points).toBe(1500);
  });

  it('has thresholds matching the spec', () => {
    expect(TIER_THRESHOLDS).toEqual([
      { tier: 'pioneer', min: 500 },
      { tier: 'champion', min: 200 },
      { tier: 'connector', min: 50 },
      { tier: 'explorer', min: 0 },
    ]);
  });
});

describe('computeNextSteps', () => {
  it('suggests certification and working group for a brand new user', () => {
    const steps = computeNextSteps({
      credentials: [],
      modulesCompleted: 0,
      workingGroupCount: 0,
      contributionCount: 0,
      profileCompleteness: 0,
      hasInProgressModule: false,
    });

    expect(steps).toHaveLength(2);
    expect(steps[0].action).toBe('start_certification');
    expect(steps[1].action).toBe('join_working_group');
  });

  it('suggests continuing certification when module is in progress', () => {
    const steps = computeNextSteps({
      credentials: [],
      modulesCompleted: 0,
      workingGroupCount: 0,
      contributionCount: 0,
      profileCompleteness: 90,
      hasInProgressModule: true,
    });

    expect(steps.some(s => s.action === 'continue_certification')).toBe(true);
  });

  it('suggests working group after certification started', () => {
    const steps = computeNextSteps({
      credentials: [],
      modulesCompleted: 2,
      workingGroupCount: 0,
      contributionCount: 0,
      profileCompleteness: 100,
      hasInProgressModule: false,
    });

    expect(steps.some(s => s.action === 'join_working_group')).toBe(true);
  });

  it('suggests sharing perspective after modules completed', () => {
    const steps = computeNextSteps({
      credentials: [{ credential_id: 'basics' }],
      modulesCompleted: 3,
      workingGroupCount: 1,
      contributionCount: 0,
      profileCompleteness: 100,
      hasInProgressModule: false,
    });

    expect(steps.some(s => s.action === 'share_perspective')).toBe(true);
  });

  it('returns at most 2 suggestions', () => {
    const steps = computeNextSteps({
      credentials: [],
      modulesCompleted: 0,
      workingGroupCount: 0,
      contributionCount: 0,
      profileCompleteness: 0,
      hasInProgressModule: false,
    });

    expect(steps.length).toBeLessThanOrEqual(2);
  });

  it('suggests advanced actions when basics are done', () => {
    const steps = computeNextSteps({
      credentials: [{ credential_id: 'practitioner' }],
      modulesCompleted: 10,
      workingGroupCount: 2,
      contributionCount: 3,
      profileCompleteness: 100,
      hasInProgressModule: false,
    });

    expect(steps.length).toBeGreaterThan(0);
    // Should suggest next cert tier or peer connections
    expect(steps.some(s =>
      s.action === 'next_certification_tier' || s.action === 'connect_with_peers'
    )).toBe(true);
  });

  it('suggests second working group when in exactly one', () => {
    const steps = computeNextSteps({
      credentials: [{ credential_id: 'basics' }],
      modulesCompleted: 5,
      workingGroupCount: 1,
      contributionCount: 2,
      profileCompleteness: 100,
      hasInProgressModule: false,
    });

    expect(steps.some(s => s.action === 'second_working_group')).toBe(true);
  });
});
