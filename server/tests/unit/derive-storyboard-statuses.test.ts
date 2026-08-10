import { describe, it, expect } from 'vitest';
import {
  deriveStoryboardStatuses,
  isNonExecutableCoverageGapScenario,
} from '../../src/addie/services/compliance-testing.js';
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
  it('classifies fixture-only UI scenarios as non-executable coverage gaps', () => {
    expect(isNonExecutableCoverageGapScenario({
      scenario: 'creative_fate_after_cancellation/fixture_preflight',
      steps: [
        { passed: true, skipped: false },
        {
          skipped: true,
          skip_reason: 'fixture_unavailable',
        },
      ],
    })).toBe(true);
  });

  it('keeps fixture-gap UI scenarios executable when a real step also failed', () => {
    expect(isNonExecutableCoverageGapScenario({
      scenario: 'creative_fate_after_cancellation/fixture_preflight',
      steps: [
        { passed: true },
        {
          passed: true,
          skipped: true,
          skip_reason: 'fixture_unavailable',
        },
        { passed: false },
      ],
    })).toBe(false);
  });

  it('classifies controller skips and their prerequisite cascades as non-executable', () => {
    expect(isNonExecutableCoverageGapScenario({
      scenario: 'stale_response_advisory/stale_response_forcing',
      steps: [
        {
          passed: true,
          skipped: true,
          skip_reason: 'missing_test_controller',
          step: 'Force upstream dependency unavailable',
        },
        {
          passed: false,
          skipped: true,
          skip_reason: 'prerequisite_failed',
          step: 'STALE_RESPONSE in errors[] on populated success response',
          warnings: ['Skipped: prior stateful step "force_upstream_unavailable" skipped (missing_test_controller); state never materialized.'],
        },
      ],
    })).toBe(true);
  });

  it('does not hide a genuine cascade after an unrelated controller skip', () => {
    const result = makeResult([
      {
        scenario: 'mixed_roots/exercise',
        passed: false,
        steps: [
          {
            passed: true,
            skipped: true,
            skip_reason: 'missing_test_controller',
            step: 'Controller setup',
          },
          {
            passed: false,
            step: 'Seller operation',
            task: 'get_products',
            error: 'Seller assertion failed',
          },
          {
            passed: false,
            skipped: true,
            skip_reason: 'prerequisite_failed',
            step: 'Dependent read',
            warnings: ['Skipped: prior stateful step failed.'],
          },
        ],
      },
    ]);

    expect(isNonExecutableCoverageGapScenario(result.tracks[0].scenarios[0])).toBe(false);
    expect(deriveStoryboardStatuses(result)).toEqual([
      {
        storyboard_id: 'mixed_roots',
        status: 'failing',
        steps_passed: 0,
        steps_total: 2,
        failure_count: 1,
        skipped_count: 1,
        first_failed_step_id: 'seller_operation',
        first_failed_step_title: 'Seller operation',
        first_failed_step_task: 'get_products',
        first_failure_message: 'Seller assertion failed',
      },
    ]);
  });

  it('does not hide a production missing-tool cascade after a neutral missing-tool skip', () => {
    const result = makeResult([
      {
        scenario: 'mixed_missing_tools/exercise',
        passed: false,
        steps: [
          {
            passed: true,
            skipped: true,
            skip_reason: 'missing_tool',
            step: 'Preview the creative',
            task: 'preview_creative',
            warnings: ['Required tool "preview_creative" not advertised; agent tools: [get_products].'],
          },
          {
            passed: false,
            skipped: true,
            skip_reason: 'missing_tool',
            step: 'Create media buy',
            task: 'create_media_buy',
            warnings: ['Agent did not advertise tool "create_media_buy"; agent tools: [get_products].'],
          },
          {
            passed: false,
            skipped: true,
            skip_reason: 'prerequisite_failed',
            step: 'Read media buy',
            task: 'get_media_buys',
            warnings: ['Skipped: prior stateful step "create_buy" skipped (missing_tool); state never materialized.'],
          },
        ],
      },
    ]);

    expect(deriveStoryboardStatuses(result)).toEqual([
      {
        storyboard_id: 'mixed_missing_tools',
        status: 'failing',
        steps_passed: 0,
        steps_total: 2,
        failure_count: 1,
        skipped_count: 1,
        first_failed_step_id: 'create_media_buy',
        first_failed_step_title: 'Create media buy',
        first_failed_step_task: 'create_media_buy',
        first_failure_message: 'Agent did not advertise tool "create_media_buy"; agent tools: [get_products].',
      },
    ]);
  });

  it('keeps same-reason cross-phase missing-tool cascades executable in the UI', () => {
    expect(isNonExecutableCoverageGapScenario({
      scenario: 'mixed_missing_tools/downstream_phase',
      steps: [
        {
          passed: true,
          skipped: true,
          skip_reason: 'missing_tool',
          step: 'Preview the creative',
          task: 'preview_creative',
          warnings: ['Required tool "preview_creative" not advertised; agent tools: [get_products].'],
        },
        {
          passed: false,
          skipped: true,
          skip_reason: 'prerequisite_failed',
          step: 'Read media buy',
          task: 'get_media_buys',
          warnings: ['Skipped: prior stateful step "create_buy" skipped (missing_tool); state never materialized.'],
        },
      ],
    })).toBe(false);
  });

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

  it('marks a storyboard untested when every produced step is not applicable', () => {
    const result = makeResult([
      {
        scenario: 'get_signals_pagination_integrity/not_applicable',
        passed: true,
        steps: [
          { passed: true, skipped: true, skip_reason: 'not_applicable', step: 'Not applicable — missing required_tools' },
        ],
      },
    ]);

    const [entry] = deriveStoryboardStatuses(result);

    expect(entry).toEqual({
      storyboard_id: 'get_signals_pagination_integrity',
      status: 'untested',
      steps_passed: 0,
      steps_total: 0,
    });
  });

  it('treats an unavailable runner fixture and any legacy cascade as untested', () => {
    const result = makeResult([
      {
        scenario: 'creative_fate_after_cancellation/get_products_brief',
        passed: true,
        steps: [
          {
            passed: true,
            step: 'Capture the seller format contract',
          },
        ],
      },
      {
        scenario: 'creative_fate_after_cancellation/sync_creative_with_assignment',
        passed: true,
        steps: [
          {
            passed: true,
            skipped: true,
            skip_reason: 'fixture_unavailable',
            step: 'Runner cannot synthesize the required creative asset',
          },
          {
            passed: true,
            skipped: true,
            skip_reason: 'prerequisite_failed',
            step: 'Observe creative state',
          },
        ],
      },
    ]);

    const [entry] = deriveStoryboardStatuses(result);

    expect(entry).toEqual({
      storyboard_id: 'creative_fate_after_cancellation',
      status: 'untested',
      steps_passed: 0,
      steps_total: 0,
    });
  });

  it('treats storyboard-level required-tool skips as untested', () => {
    const result = makeResult([
      {
        scenario: 'collection_lists/missing_tool',
        passed: true,
        steps: [
          {
            passed: true,
            skipped: true,
            skip_reason: 'missing_tool',
            step_id: 'missing_tool',
            step: 'Skipped — agent does not advertise any of [list_collection_lists]',
          },
        ],
      },
    ]);

    const [entry] = deriveStoryboardStatuses(result);

    expect(entry).toEqual({
      storyboard_id: 'collection_lists',
      status: 'untested',
      steps_passed: 0,
      steps_total: 0,
    });
  });

  it('treats explicit requires_tool skips as untested', () => {
    const result = makeResult([
      {
        scenario: 'media_buy_seller/governance_setup',
        passed: true,
        steps: [
          {
            passed: true,
            skipped: true,
            skip_reason: 'missing_tool',
            step: 'Register governance agents',
            step_id: 'sync_governance',
            task: 'sync_governance',
            warnings: ['Required tool "sync_governance" not advertised; agent tools: [get_products, create_media_buy].'],
          },
        ],
      },
    ]);

    const [entry] = deriveStoryboardStatuses(result);

    expect(entry).toEqual({
      storyboard_id: 'media_buy_seller',
      status: 'untested',
      steps_passed: 0,
      steps_total: 0,
    });
  });

  it('excludes explicit requires_tool skips from mixed storyboard totals', () => {
    const result = makeResult([
      {
        scenario: 'creative_lifecycle/build_and_preview',
        passed: true,
        steps: [
          { passed: true, step: 'Sync creative', step_id: 'sync_creative', task: 'sync_creatives' },
          {
            passed: true,
            skipped: true,
            skip_reason: 'missing_tool',
            step: 'Preview the display creative',
            step_id: 'preview_display',
            task: 'preview_creative',
            warnings: ['Required tool "preview_creative" not advertised; agent tools: [list_creative_formats, sync_creatives].'],
          },
        ],
      },
    ]);

    const [entry] = deriveStoryboardStatuses(result);

    expect(entry).toEqual({
      storyboard_id: 'creative_lifecycle',
      status: 'passing',
      steps_passed: 1,
      steps_total: 1,
    });
  });

  it('excludes prerequisite cascades caused by explicit requires_tool skips', () => {
    const result = makeResult([
      {
        scenario: 'creative_lifecycle/build_and_preview',
        passed: false,
        steps: [
          {
            passed: true,
            skipped: true,
            skip_reason: 'missing_tool',
            step: 'Preview the display creative',
            task: 'preview_creative',
            warnings: ['Required tool "preview_creative" not advertised; agent tools: [build_creative].'],
          },
          {
            passed: true,
            skipped: true,
            skip_reason: 'prerequisite_failed',
            step: 'Build a VAST tag for the video creative',
            task: 'build_creative',
            warnings: ['Skipped: prior stateful step "preview_display" skipped (missing_tool); state never materialized.'],
          },
        ],
      },
    ]);

    const [entry] = deriveStoryboardStatuses(result);

    expect(entry).toEqual({
      storyboard_id: 'creative_lifecycle',
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
