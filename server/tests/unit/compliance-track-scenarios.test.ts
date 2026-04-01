import { describe, it, expect } from 'vitest';
import { TRACK_SCENARIOS } from '../../src/addie/services/compliance-testing.js';

describe('TRACK_SCENARIOS', () => {
  it('maps reporting track to reporting_flow and deterministic_delivery', () => {
    expect(TRACK_SCENARIOS.reporting).toContain('reporting_flow');
    expect(TRACK_SCENARIOS.reporting).toContain('deterministic_delivery');
    expect(TRACK_SCENARIOS.reporting.length).toBe(2);
  });

  it('every track has at least one scenario or is explicitly empty', () => {
    const emptyTracks = Object.entries(TRACK_SCENARIOS)
      .filter(([, scenarios]) => scenarios.length === 0)
      .map(([track]) => track);
    // Tracks without scenarios get 'skip' status.
    // Reporting should not be in this list — it was previously stuck at 'expected'.
    expect(emptyTracks).not.toContain('reporting');
  });
});
