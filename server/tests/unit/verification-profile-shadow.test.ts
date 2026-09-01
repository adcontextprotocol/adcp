import { describe, expect, it } from 'vitest';
import type { ComplianceResult } from '@adcp/sdk/testing';
import { deriveVerificationProfileShadowAssessment } from '../../src/services/verification-profile-shadow.js';

function resultWith(
  scenarios: Array<{
    scenario: string;
    overall_passed: boolean;
    steps?: Array<Record<string, unknown>>;
  }>,
  overrides: Partial<ComplianceResult> = {},
): ComplianceResult {
  const storyboardIds = [...new Set(scenarios.map(({ scenario }) => {
    const separator = scenario.lastIndexOf('/');
    return separator > 0 ? scenario.slice(0, separator) : scenario;
  }))];
  return {
    agent_url: 'https://seller.example.test/mcp',
    adcp_version: '3.1.0',
    completeness: 'complete',
    agent_profile: { name: 'Example seller', tools: [] },
    overall_status: 'passing',
    tracks: [{
      track: 'media_buy',
      status: 'pass',
      label: 'Media buy',
      scenarios: scenarios as never,
      skipped_scenarios: [],
      observations: [],
      duration_ms: 10,
    }],
    tested_tracks: [],
    skipped_tracks: [],
    summary: {
      tracks_passed: 1,
      tracks_failed: 0,
      tracks_skipped: 0,
      tracks_partial: 0,
      tracks_silent: 0,
      headline: 'Complete',
    },
    observations: [],
    tested_at: '2026-08-30T00:00:00.000Z',
    total_duration_ms: 10,
    notices: [],
    bundle_results: [{
      kind: 'universal',
      id: 'shadow-test-bundle',
      storyboard_ids: storyboardIds,
      status: 'passing',
    }],
    ...overrides,
  };
}

const passedStep = { step: 'Observe behavior', passed: true, duration_ms: 1 };

describe('deriveVerificationProfileShadowAssessment', () => {
  it('fails closed when a synthetic controller gap cannot be proven from the exact catalog', () => {
    const result = resultWith([
      {
        scenario: 'media_buy_seller/create/observe',
        overall_passed: true,
        steps: [passedStep],
      },
      {
        scenario: 'media_buy_seller/create/force_approval',
        overall_passed: true,
        steps: [
          { step: 'Force approval', passed: true, skipped: true, skip_reason: 'missing_test_controller', duration_ms: 0 },
          {
            step: 'Read approval',
            passed: true,
            skipped: true,
            skip_reason: 'prerequisite_failed',
            details: 'prior stateful step "Force approval" skipped (missing_test_controller)',
            duration_ms: 0,
          },
        ],
      },
    ]);

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'passing');

    expect(assessment).toMatchObject({
      policy_version: 'verification-profiles-v2',
      proposed_spec_status: 'partial',
      proposed_sandbox_status: 'partial',
      recommended_profile: null,
      controller_gap_phase_count: 1,
      controller_gap_step_count: 1,
      controller_cascade_step_count: 1,
      selected_storyboard_count: 1,
    });
  });

  it('does not hide an observable failure from either candidate profile', () => {
    const result = resultWith([{
      scenario: 'media_buy_seller/observe',
      overall_passed: false,
      steps: [{ step: 'Validate response', passed: false, error: 'invalid response', duration_ms: 1 }],
    }], { overall_status: 'failing' });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'failing');

    expect(assessment.proposed_spec_status).toBe('failing');
    expect(assessment.proposed_sandbox_status).toBe('failing');
    expect(assessment.observed_failure_count).toBe(1);
    expect(assessment.sandbox_observable_failure_count).toBe(1);
  });

  it('never evaluates Sandbox on Testing endpoints', () => {
    const result = resultWith([{
      scenario: 'deterministic_testing/force_state',
      overall_passed: true,
      steps: [{ step: 'Force state', passed: true, skipped: true, skip_reason: 'missing_test_controller', duration_ms: 0 }],
    }]);

    const assessment = deriveVerificationProfileShadowAssessment(result, 'testing', 'passing');

    expect(assessment.proposed_spec_status).toBe('partial');
    expect(assessment.proposed_sandbox_status).toBeNull();
    expect(assessment.sandbox_eligible).toBe(false);
    expect(assessment.recommended_profile).toBe('spec');
  });

  it('classifies a catalog-known controller-only missing storyboard by profile', () => {
    const result = resultWith([{
      scenario: 'capability_discovery/discover',
      overall_passed: true,
      steps: [passedStep],
    }], {
      storyboards_missing_tools: ['deterministic_testing'],
      bundle_results: [
        {
          kind: 'universal',
          id: 'capability-discovery',
          storyboard_ids: ['capability_discovery'],
          status: 'passing',
        },
        {
          kind: 'universal',
          id: 'deterministic-testing',
          storyboard_ids: ['deterministic_testing'],
          status: 'partial',
        },
      ],
    });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'passing');

    expect(assessment.controller_missing_storyboard_count).toBe(1);
    expect(assessment.other_missing_storyboard_count).toBe(0);
    expect(assessment.proposed_spec_status).toBe('partial');
    expect(assessment.proposed_sandbox_status).toBe('passing');
    expect(assessment.recommended_profile).toBe('sandbox');
  });

  it('fails closed on a contradictory mixed-tool missing-storyboard record', () => {
    const result = resultWith([{
      scenario: 'capability_discovery/discover',
      overall_passed: true,
      steps: [passedStep],
    }], {
      adcp_version: '3.1.18',
      agent_profile: { name: 'Example seller', tools: ['get_products'] },
      storyboards_missing_tools: ['media_buy_seller/audience_buy_flow'],
      bundle_results: [{
        kind: 'specialism',
        id: 'sales-media-buy',
        storyboard_ids: ['capability_discovery', 'media_buy_seller/audience_buy_flow'],
        status: 'passing',
      }],
    });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'passing');

    expect(assessment.controller_missing_storyboard_count).toBe(0);
    expect(assessment.other_missing_storyboard_count).toBe(1);
    expect(assessment.proposed_spec_status).toBe('partial');
    expect(assessment.proposed_sandbox_status).toBe('partial');
  });

  it('grades a catalog-proven controller phase when the shared endpoint executes it successfully', () => {
    const result = resultWith([
      {
        scenario: 'capability_discovery/discover',
        overall_passed: true,
        steps: [passedStep],
      },
      {
        scenario: 'deterministic_testing/controller_validation',
        overall_passed: true,
        steps: [{
          step: 'Validate controller',
          task: 'comply_test_controller',
          passed: true,
          duration_ms: 1,
        }],
      },
    ], {
      adcp_version: '3.1.18',
    });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'passing');

    expect(assessment.controller_gap_phase_count).toBe(0);
    expect(assessment.applicable_phase_count).toBe(2);
    expect(assessment.proposed_sandbox_status).toBe('passing');
  });

  it('grades an exposed controller-phase failure under Sandbox', () => {
    const result = resultWith([{
      scenario: 'deterministic_testing/controller_validation',
      overall_passed: false,
      steps: [{
        step: 'Validate controller',
        task: 'comply_test_controller',
        passed: false,
        duration_ms: 1,
      }],
    }], {
      adcp_version: '3.1.18',
      overall_status: 'failing',
      bundle_results: [{
        kind: 'universal',
        id: 'deterministic-testing',
        storyboard_ids: ['deterministic_testing'],
        status: 'failing',
      }],
    });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'failing');

    expect(assessment.controller_gap_phase_count).toBe(0);
    expect(assessment.sandbox_observable_failure_count).toBe(1);
    expect(assessment.proposed_sandbox_status).toBe('failing');
  });

  it('keeps a mixed executed controller-gap bundle unresolved without complete SDK cause evidence', () => {
    const phases = [
      'setup',
      'audience_binding',
      'create_buy_with_audience',
      'rejection_unbound_audience',
    ].map((phase) => ({
      scenario: `media_buy_seller/audience_buy_flow/${phase}`,
      overall_passed: true,
      steps: [passedStep],
    }));
    const result = resultWith([
      ...phases,
      {
        scenario: 'media_buy_seller/audience_buy_flow/delivery_check',
        overall_passed: true,
        steps: [{
          step: 'Seed delivery',
          task: 'comply_test_controller',
          passed: true,
          skipped: true,
          skip_reason: 'missing_test_controller',
          duration_ms: 0,
        }],
      },
    ], {
      adcp_version: '3.1.18',
      overall_status: 'partial',
      bundle_results: [{
        kind: 'specialism',
        id: 'sales-media-buy',
        storyboard_ids: ['media_buy_seller/audience_buy_flow'],
        status: 'partial',
      }],
    });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'partial');

    expect(assessment.incomplete_bundle_count).toBe(1);
    expect(assessment.sandbox_unresolved_bundle_count).toBe(1);
    expect(assessment.controller_gap_phase_count).toBe(1);
    expect(assessment.proposed_spec_status).toBe('partial');
    expect(assessment.proposed_sandbox_status).toBe('partial');
  });

  it('fails closed when a controller skip contradicts the exact phase catalog', () => {
    const result = resultWith([
      {
        scenario: 'media_buy_seller/audience_buy_flow/setup',
        overall_passed: true,
        steps: [{
          step: 'Unexpected controller skip',
          passed: true,
          skipped: true,
          skip_reason: 'missing_test_controller',
          duration_ms: 0,
        }],
      },
      ...[
        'audience_binding',
        'create_buy_with_audience',
        'rejection_unbound_audience',
      ].map((phase) => ({
        scenario: `media_buy_seller/audience_buy_flow/${phase}`,
        overall_passed: true,
        steps: [passedStep],
      })),
      {
        scenario: 'media_buy_seller/audience_buy_flow/delivery_check',
        overall_passed: true,
        steps: [{
          step: 'Expected controller skip',
          task: 'comply_test_controller',
          passed: true,
          skipped: true,
          skip_reason: 'missing_test_controller',
          duration_ms: 0,
        }],
      },
    ], {
      adcp_version: '3.1.18',
      overall_status: 'partial',
      bundle_results: [{
        kind: 'specialism',
        id: 'sales-media-buy',
        storyboard_ids: ['media_buy_seller/audience_buy_flow'],
        status: 'partial',
      }],
    });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'partial');

    expect(assessment.non_controller_gap_step_count).toBeGreaterThan(0);
    expect(assessment.sandbox_unresolved_bundle_count).toBe(1);
    expect(assessment.proposed_sandbox_status).toBe('partial');
  });

  it('keeps zero-applicable and timed-out Sandbox evidence partial', () => {
    const result = resultWith([], { completeness: 'timed_out', overall_status: 'partial' });
    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'partial');

    expect(assessment.proposed_spec_status).toBe('partial');
    expect(assessment.proposed_sandbox_status).toBe('partial');
    expect(assessment.run_complete).toBe(false);
  });

  it('fails closed when the additive completeness field is absent', () => {
    const result = resultWith([{
      scenario: 'media_buy_seller/observe',
      overall_passed: true,
      steps: [passedStep],
    }]);
    delete result.completeness;

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'passing');

    expect(assessment.run_complete).toBe(false);
    expect(assessment.proposed_spec_status).toBe('partial');
    expect(assessment.proposed_sandbox_status).toBe('partial');
  });

  it('fails closed when authoritative bundle evidence is absent', () => {
    const result = resultWith([{
      scenario: 'media_buy_seller/observe',
      overall_passed: true,
      steps: [passedStep],
    }]);
    delete result.bundle_results;

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'passing');

    expect(assessment.bundle_evidence_present).toBe(false);
    expect(assessment.proposed_spec_status).toBe('partial');
    expect(assessment.proposed_sandbox_status).toBe('partial');
  });

  it('blocks both candidates on a failing authoritative bundle', () => {
    const result = resultWith([{
      scenario: 'media_buy_seller/observe',
      overall_passed: true,
      steps: [passedStep],
    }], {
      bundle_results: [{
        kind: 'specialism',
        id: 'sales-media-buy',
        storyboard_ids: ['media_buy_seller'],
        status: 'failing',
      }],
    });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'passing');

    expect(assessment.failing_bundle_count).toBe(1);
    expect(assessment.proposed_spec_status).toBe('failing');
    expect(assessment.proposed_sandbox_status).toBe('failing');
  });

  it('does not let a controller gap explain an unrelated failing bundle', () => {
    const result = resultWith([
      {
        scenario: 'deterministic_testing/controller_validation',
        overall_passed: true,
        steps: [{
          step: 'Controller unavailable',
          passed: true,
          skipped: true,
          skip_reason: 'missing_test_controller',
          duration_ms: 0,
        }],
      },
      {
        scenario: 'media_buy_seller/observe',
        overall_passed: true,
        steps: [passedStep],
      },
    ], {
      overall_status: 'failing',
      bundle_results: [{
        kind: 'specialism',
        id: 'sales-media-buy',
        storyboard_ids: ['deterministic_testing', 'media_buy_seller'],
        status: 'failing',
      }],
    });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'failing');

    expect(assessment.controller_gap_phase_count).toBe(1);
    expect(assessment.proposed_sandbox_status).toBe('failing');
  });

  it('keeps both candidates partial on incomplete authoritative bundles', () => {
    const result = resultWith([{
      scenario: 'media_buy_seller/observe',
      overall_passed: true,
      steps: [passedStep],
    }], {
      bundle_results: [{
        kind: 'specialism',
        id: 'sales-media-buy',
        storyboard_ids: ['media_buy_seller'],
        status: 'untested',
      }],
    });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'passing');

    expect(assessment.incomplete_bundle_count).toBe(1);
    expect(assessment.sandbox_unresolved_bundle_count).toBe(1);
    expect(assessment.proposed_spec_status).toBe('partial');
    expect(assessment.proposed_sandbox_status).toBe('partial');
  });

  it.each(['seeded_state', 'future_runtime_gate'])('does not neutralize unmet %s requirements', (requirement) => {
    const result = resultWith([{
      scenario: 'media_buy_seller/observe',
      overall_passed: true,
      steps: [{
        step: 'Unmet runtime requirement',
        passed: true,
        skipped: true,
        skip_reason: 'requirement_unmet',
        requirement,
        duration_ms: 0,
      }],
    }]);

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'passing');

    expect(assessment.non_controller_gap_step_count).toBe(1);
    expect(assessment.proposed_sandbox_status).toBe('partial');
  });

  it('blocks detached failures while treating their storyboard and step identity as attribution', () => {
    const result = resultWith([{
      scenario: 'media_buy_seller/observe',
      overall_passed: true,
      steps: [passedStep],
    }], {
      failures: [{
        track: 'media_buy',
        storyboard_id: 'media_buy_seller',
        step_id: 'detached',
        step_title: 'Detached failure',
        task: 'get_products',
        error: 'failed outside the summarized track',
        fix_command: 'storyboard run',
      }],
    });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'passing');

    expect(assessment.unattributed_failure_count).toBe(0);
    expect(assessment.proposed_spec_status).toBe('failing');
    expect(assessment.proposed_sandbox_status).toBe('failing');
  });

  it('reports malformed flat failures as unattributed while remaining fail-closed', () => {
    const result = resultWith([{
      scenario: 'media_buy_seller/observe',
      overall_passed: true,
      steps: [passedStep],
    }], {
      failures: [{
        track: 'media_buy',
        storyboard_id: '',
        step_id: '',
        step_title: 'Malformed failure',
        task: 'get_products',
        error: 'missing evidence identity',
        fix_command: 'storyboard run',
      }],
    });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'passing');

    expect(assessment.unattributed_failure_count).toBe(1);
    expect(assessment.proposed_spec_status).toBe('failing');
    expect(assessment.proposed_sandbox_status).toBe('failing');
  });

  it('does not promote an unexplained public partial result to Sandbox passing', () => {
    const result = resultWith([{
      scenario: 'media_buy_seller/observe',
      overall_passed: true,
      steps: [passedStep],
    }], { overall_status: 'partial' });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'partial');

    expect(assessment.proposed_spec_status).toBe('partial');
    expect(assessment.proposed_sandbox_status).toBe('partial');
  });

  it('does not promote a mixed controller phase containing a failure', () => {
    const result = resultWith([{
      scenario: 'media_buy_seller/controller_then_validate',
      overall_passed: false,
      steps: [
        { step: 'Set state', passed: true, skipped: true, skip_reason: 'missing_test_controller', duration_ms: 0 },
        { step: 'Validate setup', passed: false, error: 'setup failed', duration_ms: 1 },
      ],
    }], { overall_status: 'failing' });

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'failing');

    expect(assessment.proposed_spec_status).toBe('failing');
    expect(assessment.proposed_sandbox_status).toBe('failing');
    expect(assessment.mixed_controller_failure_phase_count).toBe(1);
  });

  it('preserves slash-bearing storyboard ids when counting selected evidence', () => {
    const result = resultWith([{
      scenario: 'media_buy_seller/refine_products/validate',
      overall_passed: true,
      steps: [passedStep],
    }]);

    const assessment = deriveVerificationProfileShadowAssessment(result, 'production', 'passing');

    expect(assessment.selected_storyboard_count).toBe(1);
  });
});
