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
  SUPPORTED_BADGE_VERSIONS: ['3.0'],
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
    // tracks_passed counts pass + silent per SDK summary semantics; the silent
    // track contributes 1 even though the overall verdict isn't promoted.
    expect(out.tracks_passed).toBe(1);
    expect(out.tracks_failed).toBe(1);
    expect(out.tracks_partial).toBe(0);
  });

  it('ignores empty skip tracks when deciding promotion', () => {
    const result = makeResult([makeTrack('silent'), makeTrack('skip', 0)], 'partial');
    const out = complianceResultToDbInput(result as any, 'https://agent.example.com/mcp', 'production');

    expect(out.overall_status).toBe('passing');
    expect(out.tracks_passed).toBe(1);
    expect(out.tracks_json).toEqual([
      expect.objectContaining({ track: 'core', has_coverage_gap_skip: false }),
      expect.objectContaining({ track: 'governance', status: 'skip', has_coverage_gap_skip: false }),
    ]);
  });

  it('does not promote when all tracks are skipped (no active tracks)', () => {
    const result = makeResult([makeTrack('skip'), makeTrack('skip')], 'partial');
    const out = complianceResultToDbInput(result as any, 'https://agent.example.com/mcp', 'production');

    // No active tracks — falls through to mapOverallStatus('partial') → 'partial'
    expect(out.overall_status).toBe('partial');
  });

  it('marks full-suite results as authoritative storyboard replacements', () => {
    const result = makeResult([makeTrack('pass')], 'passing');
    const out = complianceResultToDbInput(result as any, 'https://agent.example.com/mcp', 'production');

    expect(out.replace_storyboard_statuses).toBe(true);
  });

  it('does not replace all storyboard rows for explicit single-storyboard runs', () => {
    const result = makeResult([makeTrack('pass')], 'passing');
    const out = complianceResultToDbInput(
      result as any,
      'https://agent.example.com/mcp',
      'production',
      'owner_test',
      ['signal_owned'],
    );

    expect(out.replace_storyboard_statuses).toBe(false);
  });

  it('preserves controller-gated reporting track as a skipped coverage gap', () => {
    const result = makeResult([
      {
        track: 'reporting',
        label: 'Reporting & Delivery',
        status: 'skip',
        duration_ms: 1000,
        skipped_scenarios: [],
        observations: [],
        scenarios: [
          {
            scenario: 'delivery_reporting/requirement_unmet',
            overall_passed: true,
            steps: [
              {
                step: 'requirement_unmet:controller',
                passed: true,
                skipped: true,
                skip_reason: 'missing_test_controller',
                duration_ms: 0,
              },
            ],
          },
        ],
      },
    ] as any);
    result.agent_profile = {
      name: 'test-agent',
      tools: ['get_media_buy_delivery'],
      supported_protocols: ['media_buy'],
    };

    const out = complianceResultToDbInput(result as any, 'https://agent.example.com/mcp', 'production');

    expect(out.tracks_json).toEqual([
      expect.objectContaining({ track: 'reporting', status: 'skip', has_coverage_gap_skip: true }),
    ]);
    expect(out.overall_status).toBe('partial');
    expect(out.tracks_passed).toBe(0);
    expect(out.tracks_skipped).toBe(1);
  });

  it('does not promote active clean tracks when reporting has controller-gated skips', () => {
    const result = makeResult([
      makeTrack('silent'),
      {
        track: 'reporting',
        label: 'Reporting & Delivery',
        status: 'skip',
        duration_ms: 1000,
        skipped_scenarios: [],
        observations: [],
        scenarios: [
          {
            scenario: 'delivery_reporting/requirement_unmet',
            overall_passed: true,
            steps: [
              {
                step: 'requirement_unmet:controller',
                passed: true,
                skipped: true,
                skip_reason: 'missing_test_controller',
                duration_ms: 0,
              },
            ],
          },
        ],
      },
    ] as any);

    const out = complianceResultToDbInput(result as any, 'https://agent.example.com/mcp', 'production');

    expect(out.overall_status).toBe('partial');
    expect(out.tracks_passed).toBe(1);
    expect(out.tracks_skipped).toBe(1);
    expect(out.tracks_json).toEqual([
      expect.objectContaining({ track: 'core', has_coverage_gap_skip: false }),
      expect.objectContaining({ track: 'reporting', status: 'skip', has_coverage_gap_skip: true }),
    ]);
  });
});
