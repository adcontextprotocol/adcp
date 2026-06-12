import { describe, it, expect } from 'vitest';
import { deriveStoryboardStatuses } from '../../src/addie/services/compliance-testing.js';
import type { ComplianceResult } from '@adcp/sdk/testing';

/**
 * Minimal builder for ComplianceResult fixtures.
 *
 * `comply()` returns one TestResult per phase of each storyboard, keyed
 * `<storyboard_id>/<phase_id>`. The fixtures here construct that shape
 * directly so the tests pin the scenario-key contract we read from the SDK.
 */
function makeResult(
  scenarios: Array<{
    scenario: string;
    passed: boolean;
    steps?: Array<{
      passed: boolean;
      step?: string;
      step_id?: string;
      task?: string;
      error?: string;
      details?: string;
      warnings?: string[];
      skipped?: boolean;
      skip_reason?: string;
      requirement?: string;
    }>;
  }>,
): ComplianceResult {
  return {
    agent_url: 'https://example.test/mcp',
    overall_status: 'passing',
    tracks: [
      {
        track: 'signals',
        label: 'Signals',
        status: 'passing',
        duration_ms: 0,
        skipped_scenarios: [],
        observations: [],
        scenarios: scenarios.map(s => ({
          agent_url: 'https://example.test/mcp',
          scenario: s.scenario as unknown as ComplianceResult['tracks'][number]['scenarios'][number]['scenario'],
          overall_passed: s.passed,
          steps: s.steps?.map(step => ({
            step: step.step ?? 'step',
            ...(step.step_id && { step_id: step.step_id }),
            ...(step.task && { task: step.task }),
            ...(step.error && { error: step.error }),
            ...(step.details && { details: step.details }),
            ...(step.warnings && { warnings: step.warnings }),
            passed: step.passed,
            ...(step.skipped && { skipped: true }),
            ...(step.skip_reason && { skip_reason: step.skip_reason }),
            ...(step.requirement && { requirement: step.requirement }),
            duration_ms: 0,
          })),
          summary: 'fixture',
          total_duration_ms: 0,
          tested_at: '2026-05-11T00:00:00.000Z',
        })),
      },
    ],
    tested_tracks: [],
    skipped_tracks: [],
    summary: {
      tracks_passed: 0,
      tracks_failed: 0,
      tracks_skipped: 0,
      tracks_partial: 0,
      tracks_silent: 0,
      headline: 'fixture',
    },
    observations: [],
    tested_at: '2026-05-11T00:00:00.000Z',
    total_duration_ms: 0,
  } as unknown as ComplianceResult;
}

describe('deriveStoryboardStatuses', () => {
  it('emits one entry per storyboard the runner produced data for', () => {
    const result = makeResult([
      { scenario: 'signal_owned/capability_discovery', passed: true, steps: [{ passed: true }] },
      { scenario: 'signal_owned/discovery', passed: true, steps: [{ passed: true }, { passed: true }] },
      { scenario: 'signals_baseline/discover_and_activate', passed: true, steps: [{ passed: true }] },
    ]);
    const entries = deriveStoryboardStatuses(result);
    const ids = entries.map(e => e.storyboard_id).sort();
    expect(ids).toEqual(['signal_owned', 'signals_baseline']);
  });

  it('marks a storyboard passing when every phase passes (step counts roll up)', () => {
    const result = makeResult([
      { scenario: 'signal_owned/capability_discovery', passed: true, steps: [{ passed: true }] },
      { scenario: 'signal_owned/discovery', passed: true, steps: [{ passed: true }, { passed: true }] },
      { scenario: 'signal_owned/activation', passed: true, steps: [{ passed: true }] },
    ]);
    const [entry] = deriveStoryboardStatuses(result);
    expect(entry).toEqual({
      storyboard_id: 'signal_owned',
      status: 'passing',
      steps_passed: 4,
      steps_total: 4,
    });
  });

  it("marks a storyboard partial when some phases' steps fail", () => {
    const result = makeResult([
      { scenario: 'signal_owned/capability_discovery', passed: true, steps: [{ passed: true }] },
      { scenario: 'signal_owned/discovery', passed: false, steps: [{ passed: true }, { passed: false }] },
    ]);
    const [entry] = deriveStoryboardStatuses(result);
    expect(entry).toMatchObject({
      storyboard_id: 'signal_owned',
      status: 'partial',
      steps_passed: 2,
      steps_total: 3,
    });
  });

  it('marks a storyboard failing when every step failed', () => {
    const result = makeResult([
      { scenario: 'signal_owned/capability_discovery', passed: false, steps: [{ passed: false }] },
      { scenario: 'signal_owned/discovery', passed: false, steps: [{ passed: false }, { passed: false }] },
    ]);
    const [entry] = deriveStoryboardStatuses(result);
    expect(entry).toMatchObject({ status: 'failing', steps_passed: 0, steps_total: 3 });
  });

  it('separates root failures from cascaded prerequisite skips', () => {
    const result = makeResult([
      {
        scenario: 'signal_owned/discovery',
        passed: false,
        steps: [
          {
            passed: false,
            step: 'Create signal',
            step_id: 'create_signal',
            task: 'create_signal',
            error: 'Expected created signal id',
          },
          { passed: true, skipped: true, skip_reason: 'prerequisite_failed', step: 'Activate signal' },
          { passed: true, skipped: true, skip_reason: 'prerequisite_failed', step: 'Read signal' },
        ],
      },
    ]);

    const [entry] = deriveStoryboardStatuses(result);

    expect(entry).toMatchObject({
      storyboard_id: 'signal_owned',
      status: 'failing',
      steps_passed: 0,
      steps_total: 3,
      failure_count: 1,
      skipped_count: 2,
      first_failed_step_id: 'create_signal',
      first_failed_step_title: 'Create signal',
      first_failed_step_task: 'create_signal',
      first_failure_message: 'Expected created signal id',
    });
  });

  it('keeps comply_test_controller skips as coverage gaps when mixed with executed steps', () => {
    const result = makeResult([
      {
        scenario: 'pagination_integrity_creative_formats/read_pages',
        passed: true,
        steps: [
          { passed: true, step: 'first_page' },
          { passed: true, step: 'second_page' },
          { passed: true, step: 'repeat_cursor' },
          { passed: true, skipped: true, skip_reason: 'missing_test_controller', step: 'seed_cursor_a' },
          { passed: true, skipped: true, skip_reason: 'missing_test_controller', step: 'seed_cursor_b' },
        ],
      },
    ]);

    const [entry] = deriveStoryboardStatuses(result);

    expect(entry).toEqual({
      storyboard_id: 'pagination_integrity_creative_formats',
      status: 'passing',
      steps_passed: 3,
      steps_total: 3,
    });
  });

  it('marks a storyboard untested when every produced step is a controller skip', () => {
    const result = makeResult([
      {
        scenario: 'delivery_reporting/requirement_unmet',
        passed: true,
        steps: [
          { passed: true, skipped: true, skip_reason: 'missing_test_controller', step: 'requirement_unmet:controller' },
        ],
      },
    ]);

    const [entry] = deriveStoryboardStatuses(result);

    expect(entry).toEqual({
      storyboard_id: 'delivery_reporting',
      status: 'untested',
      steps_passed: 0,
      steps_total: 0,
    });
  });

  it('still counts missing production-tool skips as non-passing coverage gaps', () => {
    const result = makeResult([
      {
        scenario: 'media_buy_seller/delivery',
        passed: true,
        steps: [
          { passed: true, skipped: true, skip_reason: 'missing_tool', step: 'get_delivery' },
        ],
      },
    ]);

    const [entry] = deriveStoryboardStatuses(result);

    expect(entry).toEqual({
      storyboard_id: 'media_buy_seller',
      status: 'failing',
      steps_passed: 0,
      steps_total: 1,
      failure_count: 1,
      skipped_count: 0,
      first_failed_step_id: 'get_delivery',
      first_failed_step_title: 'get_delivery',
      first_failed_step_task: null,
      first_failure_message: 'missing_tool',
    });
  });

  it('still counts non-controller requirement gaps as non-passing coverage gaps', () => {
    const result = makeResult([
      {
        scenario: 'accounts_baseline/requirement_unmet',
        passed: true,
        steps: [
          { passed: true, skipped: true, skip_reason: 'requirement_unmet', step: 'required_tool_family_missing' },
        ],
      },
    ]);

    const [entry] = deriveStoryboardStatuses(result);

    expect(entry).toEqual({
      storyboard_id: 'accounts_baseline',
      status: 'failing',
      steps_passed: 0,
      steps_total: 1,
      failure_count: 1,
      skipped_count: 0,
      first_failed_step_id: 'required_tool_family_missing',
      first_failed_step_title: 'required_tool_family_missing',
      first_failed_step_task: null,
      first_failure_message: 'requirement_unmet',
    });
  });

  it('treats controller requirement gaps as untested', () => {
    const result = makeResult([
      {
        scenario: 'delivery_reporting/requirement_unmet',
        passed: true,
        steps: [
          {
            passed: true,
            skipped: true,
            skip_reason: 'requirement_unmet',
            requirement: 'controller',
            step: 'requirement_unmet:controller',
          },
        ],
      },
    ]);

    const [entry] = deriveStoryboardStatuses(result);

    expect(entry).toEqual({
      storyboard_id: 'delivery_reporting',
      status: 'untested',
      steps_passed: 0,
      steps_total: 0,
    });
  });

  it('preserves step-less phase failures when other phases have controller skips', () => {
    const result = makeResult([
      { scenario: 'mixed_storyboard/resource_resolution', passed: false, steps: [] },
      {
        scenario: 'mixed_storyboard/requirement_unmet',
        passed: true,
        steps: [
          { passed: true, skipped: true, skip_reason: 'missing_test_controller', step: 'requirement_unmet:controller' },
        ],
      },
    ]);

    const [entry] = deriveStoryboardStatuses(result);

    expect(entry).toEqual({
      storyboard_id: 'mixed_storyboard',
      status: 'failing',
      steps_passed: 0,
      steps_total: 1,
      failure_count: 1,
      skipped_count: 0,
      first_failed_step_id: 'resource_resolution',
      first_failed_step_title: 'resource_resolution',
      first_failed_step_task: null,
      first_failure_message: 'fixture',
    });
  });

  it('falls back to phase-level counts when phases have no steps array', () => {
    const result = makeResult([
      { scenario: 'signal_owned/capability_discovery', passed: true },
      { scenario: 'signal_owned/discovery', passed: false },
    ]);
    const [entry] = deriveStoryboardStatuses(result);
    expect(entry).toMatchObject({
      storyboard_id: 'signal_owned',
      status: 'partial',
      steps_passed: 1,
      steps_total: 2,
    });
  });

  it('skips legacy bare-name scenarios (no "/" separator)', () => {
    const result = makeResult([
      { scenario: 'signals_flow', passed: true, steps: [{ passed: true }] },
      { scenario: 'capability_discovery', passed: true, steps: [{ passed: true }] },
    ]);
    expect(deriveStoryboardStatuses(result)).toEqual([]);
  });

  it('returns empty when no scenarios were produced', () => {
    expect(deriveStoryboardStatuses(makeResult([]))).toEqual([]);
  });

  it('aggregates a storyboard whose phases appear in multiple tracks', () => {
    const r = makeResult([]);
    r.tracks = [
      {
        track: 'core',
        label: 'Core',
        status: 'passing',
        duration_ms: 0,
        skipped_scenarios: [],
        observations: [],
        scenarios: [
          {
            agent_url: 'https://example.test/mcp',
            scenario: 'sales_non_guaranteed/capability_discovery' as never,
            overall_passed: true,
            steps: [{ step: 'a', passed: true, duration_ms: 0 }],
            summary: '',
            total_duration_ms: 0,
            tested_at: '',
          },
        ],
      },
      {
        track: 'media_buy',
        label: 'Media Buy',
        status: 'passing',
        duration_ms: 0,
        skipped_scenarios: [],
        observations: [],
        scenarios: [
          {
            agent_url: 'https://example.test/mcp',
            scenario: 'sales_non_guaranteed/create_buy' as never,
            overall_passed: true,
            steps: [{ step: 'b', passed: true, duration_ms: 0 }, { step: 'c', passed: false, duration_ms: 0 }],
            summary: '',
            total_duration_ms: 0,
            tested_at: '',
          },
        ],
      },
    ] as unknown as ComplianceResult['tracks'];
    const entries = deriveStoryboardStatuses(r);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      storyboard_id: 'sales_non_guaranteed',
      status: 'partial',
      steps_passed: 2,
      steps_total: 3,
    });
  });

  it('handles result.tracks being absent', () => {
    const r = makeResult([]);
    (r as { tracks?: unknown }).tracks = undefined;
    expect(deriveStoryboardStatuses(r)).toEqual([]);
  });

  it('ignores non-string scenario values without throwing', () => {
    const r = makeResult([]);
    r.tracks[0].scenarios = [
      {
        agent_url: 'https://example.test/mcp',
        scenario: null as never,
        overall_passed: true,
        steps: [{ step: 'x', passed: true, duration_ms: 0 }],
        summary: '',
        total_duration_ms: 0,
        tested_at: '',
      },
      {
        agent_url: 'https://example.test/mcp',
        scenario: 12345 as never,
        overall_passed: true,
        steps: [{ step: 'y', passed: true, duration_ms: 0 }],
        summary: '',
        total_duration_ms: 0,
        tested_at: '',
      },
    ];
    expect(deriveStoryboardStatuses(r)).toEqual([]);
  });

  describe('with explicit storyboardIds', () => {
    it('emits untested entry when the runner did not run a requested storyboard', () => {
      const result = makeResult([
        { scenario: 'signal_owned/capability_discovery', passed: true, steps: [{ passed: true }] },
      ]);
      const entries = deriveStoryboardStatuses(result, ['signal_owned', 'signal_marketplace']);
      expect(entries).toEqual([
        { storyboard_id: 'signal_owned', status: 'passing', steps_passed: 1, steps_total: 1 },
        { storyboard_id: 'signal_marketplace', status: 'untested', steps_passed: 0, steps_total: 0 },
      ]);
    });

    it('only emits entries for the requested ids even when more were run', () => {
      const result = makeResult([
        { scenario: 'signal_owned/p1', passed: true, steps: [{ passed: true }] },
        { scenario: 'signals_baseline/p1', passed: true, steps: [{ passed: true }] },
      ]);
      const entries = deriveStoryboardStatuses(result, ['signal_owned']);
      expect(entries.map(e => e.storyboard_id)).toEqual(['signal_owned']);
    });
  });
});
