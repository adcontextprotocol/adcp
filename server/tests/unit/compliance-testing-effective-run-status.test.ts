import { describe, it, expect, vi } from 'vitest';

vi.mock('@adcp/sdk/testing', () => ({
  setAgentTesterLogger: vi.fn(),
  comply: vi.fn(),
  loadComplianceIndex: vi.fn(() => ({ specialisms: [] })),
  SAMPLE_BRIEFS: [],
  getBriefsByVertical: vi.fn(() => []),
}));

vi.mock('../../src/services/storyboards.js', () => ({
  getStoryboard: vi.fn(() => null),
  getAllStoryboards: vi.fn(() => []),
}));

vi.mock('../../src/services/adcp-taxonomy.js', () => ({
  isStableSpecialism: vi.fn(() => true),
}));

import { complianceResultToDbInput } from '../../src/addie/services/compliance-testing.js';

function makeTrack(status: string, scenarioCount = 3) {
  return {
    track: status === 'skip' ? 'governance' : 'core',
    label: status === 'skip' ? 'Governance' : 'Core',
    status,
    duration_ms: 1000,
    scenarios: Array.from({ length: scenarioCount }, (_, i) => ({
      scenario: `scenario_${i}`,
      overall_passed: status !== 'fail',
      steps: [],
    })),
  };
}

function makeResult(tracks: ReturnType<typeof makeTrack>[], overallStatus = 'partial') {
  const nonSkip = tracks.filter(t => t.status !== 'skip');
  const passed = nonSkip.filter(t => t.status === 'pass' || t.status === 'silent').length;
  const failed = nonSkip.filter(t => t.status === 'fail').length;
  const partial = nonSkip.filter(t => t.status === 'partial').length;
  return {
    overall_status: overallStatus,
    tracks,
    summary: {
      headline: 'Test headline',
      tracks_passed: passed,
      tracks_failed: failed,
      tracks_partial: partial,
      tracks_skipped: tracks.filter(t => t.status === 'skip').length,
    },
    total_duration_ms: 2000,
    agent_profile: { name: 'test-agent', tools: [] },
    observations: [],
  };
}

describe('complianceResultToDbInput — effectiveRunStatus', () => {
  it('promotes all-silent to passing with zero partial/failed counters', () => {
    const result = makeResult([makeTrack('silent'), makeTrack('silent')], 'partial');
    const out = complianceResultToDbInput(result as any, 'https://agent.example.com/mcp', 'production');

    expect(out.overall_status).toBe('passing');
    expect(out.tracks_passed).toBe(2);
    expect(out.tracks_failed).toBe(0);
    expect(out.tracks_partial).toBe(0);
  });

  it('promotes mixed pass+silent to passing', () => {
    const result = makeResult([makeTrack('pass'), makeTrack('silent')], 'partial');
    const out = complianceResultToDbInput(result as any, 'https://agent.example.com/mcp', 'production');

    expect(out.overall_status).toBe('passing');
    expect(out.tracks_passed).toBe(2);
    expect(out.tracks_failed).toBe(0);
    expect(out.tracks_partial).toBe(0);
  });

  it('does not promote when at least one track fails', () => {
    const result = makeResult([makeTrack('silent'), makeTrack('fail')], 'partial');
    const out = complianceResultToDbInput(result as any, 'https://agent.example.com/mcp', 'production');

    expect(out.overall_status).toBe('partial');
    expect(out.tracks_passed).toBe(0);
    expect(out.tracks_failed).toBe(1);
    expect(out.tracks_partial).toBe(0);
  });

  it('ignores skip tracks when deciding promotion', () => {
    const result = makeResult([makeTrack('silent'), makeTrack('skip')], 'partial');
    const out = complianceResultToDbInput(result as any, 'https://agent.example.com/mcp', 'production');

    expect(out.overall_status).toBe('passing');
    expect(out.tracks_passed).toBe(1);
  });

  it('does not promote when all tracks are skipped (no active tracks)', () => {
    const result = makeResult([makeTrack('skip'), makeTrack('skip')], 'partial');
    const out = complianceResultToDbInput(result as any, 'https://agent.example.com/mcp', 'production');

    // No active tracks — falls through to mapOverallStatus('partial') → 'partial'
    expect(out.overall_status).toBe('partial');
  });
});
