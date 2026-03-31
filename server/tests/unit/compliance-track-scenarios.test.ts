import { describe, it, expect } from 'vitest';
import { TRACK_SCENARIOS } from '../../src/addie/services/compliance-testing.js';

describe('TRACK_SCENARIOS', () => {
  it('maps reporting track to full_sales_flow', () => {
    expect(TRACK_SCENARIOS.reporting).toContain('full_sales_flow');
    expect(TRACK_SCENARIOS.reporting.length).toBeGreaterThan(0);
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
