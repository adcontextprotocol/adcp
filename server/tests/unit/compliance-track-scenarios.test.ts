import { describe, it, expect } from 'vitest';
import { TRACK_SCENARIOS, buildScenarioList } from '../../src/addie/services/compliance-testing.js';

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
