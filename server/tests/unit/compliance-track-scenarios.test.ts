import { describe, it, expect } from 'vitest';
import { TRACK_SCENARIOS, buildScenarioList, PLATFORM_STORYBOARDS } from '../../src/addie/services/compliance-testing.js';
import { getStoryboard } from '../../src/services/storyboards.js';

describe('TRACK_SCENARIOS', () => {
  it('maps reporting track to deterministic_delivery', () => {
    expect(TRACK_SCENARIOS.reporting).toContain('deterministic_delivery');
    expect(TRACK_SCENARIOS.reporting.length).toBe(1);
  });

  it('every track has at least one scenario or is explicitly empty', () => {
    const emptyTracks = Object.entries(TRACK_SCENARIOS)
      .filter(([, scenarios]) => scenarios.length === 0)
      .map(([track]) => track);
    // Every track with scenarios gets tested; tracks without scenarios get 'skip' status.
    expect(emptyTracks).not.toContain('reporting');
  });
});

describe('buildScenarioList', () => {
  it('includes reporting scenarios', () => {
    const scenarios = buildScenarioList(['reporting']);
    expect(scenarios).toContain('deterministic_delivery');
  });

  it('includes all track scenarios when no tracks specified', () => {
    const scenarios = buildScenarioList();
    for (const [, trackScenarios] of Object.entries(TRACK_SCENARIOS)) {
      for (const scenario of trackScenarios) {
        expect(scenarios).toContain(scenario);
      }
    }
  });
});

describe('PLATFORM_STORYBOARDS', () => {
  it('every platform type maps to at least one storyboard', () => {
    for (const [, storyboards] of Object.entries(PLATFORM_STORYBOARDS)) {
      expect(storyboards.length).toBeGreaterThan(0);
    }
  });

  it('every mapped storyboard ID is a valid storyboard', () => {
    const allIds = new Set<string>();
    for (const storyboards of Object.values(PLATFORM_STORYBOARDS)) {
      for (const id of storyboards) {
        allIds.add(id);
      }
    }
    for (const id of allIds) {
      expect(getStoryboard(id)).toBeDefined();
    }
  });

  it('si_platform maps to si_session', () => {
    expect(PLATFORM_STORYBOARDS.si_platform).toContain('si_session');
  });

  it('social_platform maps to social_platform storyboard', () => {
    expect(PLATFORM_STORYBOARDS.social_platform).toContain('social_platform');
  });

  it('every platform type includes capability_discovery', () => {
    for (const [, storyboards] of Object.entries(PLATFORM_STORYBOARDS)) {
      expect(storyboards).toContain('capability_discovery');
    }
  });
});
