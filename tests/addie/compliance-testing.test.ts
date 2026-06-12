import { describe, expect, it } from 'vitest';
import type { ComplianceResult } from '@adcp/sdk/testing';
import {
  complianceResultToDbInput,
  deriveStoryboardStatuses,
  extractFailingStepDiagnostics,
} from '../../server/src/addie/services/compliance-testing.js';

function baseResult(overrides: Partial<ComplianceResult>): ComplianceResult {
  return {
    agent_url: 'https://agent.example/mcp',
    adcp_version: '3.1.0-rc.12',
    agent_profile: {},
    overall_status: 'partial',
    tracks: [],
    tested_tracks: [],
    skipped_tracks: [],
    summary: {
      tracks_passed: 0,
      tracks_failed: 0,
      tracks_skipped: 0,
      tracks_partial: 1,
      tracks_silent: 0,
      headline: 'Partial',
    },
    observations: [],
    tested_at: '2026-06-10T00:00:00.000Z',
    ...overrides,
  } as ComplianceResult;
}

describe('compliance result adapter', () => {
  it('does not count controller-only not-applicable skips against storyboard pass totals', () => {
    const result = baseResult({
      tracks: [
        {
          track: 'error_handling',
          label: 'Error handling',
          status: 'partial',
          duration_ms: 123,
          scenarios: [
            {
              scenario: 'stale_response_advisory/stale_response_forcing',
              overall_passed: false,
              steps: [
                {
                  step: 'Force upstream dependency unavailable',
                  step_id: 'force_upstream_unavailable',
                  task: 'comply_test_controller',
                  skipped: true,
                  skip_reason: 'missing_test_controller',
                  passed: false,
                },
                {
                  step: 'STALE_RESPONSE in errors[] on populated success response',
                  step_id: 'stale_response_wire_placement',
                  task: 'get_products',
                  skipped: true,
                  skip_reason: 'missing_test_controller',
                  passed: false,
                  error: 'prior stateful step force_upstream_unavailable skipped; state never materialized',
                },
              ],
            },
            {
              scenario: 'stale_response_advisory/non_emission_guard',
              overall_passed: true,
              steps: [
                {
                  step: 'STALE_RESPONSE absent on healthy upstream response',
                  step_id: 'no_stale_on_healthy_upstream',
                  task: 'get_products',
                  skipped: false,
                  passed: true,
                },
              ],
            },
          ],
        },
      ],
    });

    expect(deriveStoryboardStatuses(result)).toEqual([
      {
        storyboard_id: 'stale_response_advisory',
        status: 'passing',
        steps_passed: 1,
        steps_total: 1,
      },
    ]);

    const dbInput = complianceResultToDbInput(result, 'https://agent.example/mcp', 'production');
    expect(dbInput.tracks_json[0]).toMatchObject({
      track: 'error_handling',
      has_coverage_gap_skip: true,
    });
  });

  it('preserves billing-gate validation path, expected value, and actual value in diagnostics', () => {
    const result = baseResult({
      overall_status: 'failing',
      tracks: [
        {
          track: 'error_handling',
          label: 'Error handling',
          status: 'fail',
          duration_ms: 77,
          scenarios: [
            {
              scenario: 'billing_gate_dispatch/per_agent_gate_reject',
              overall_passed: false,
              steps: [
                {
                  step: 'Passthrough-only buyer agent submits billing: agent',
                  step_id: 'sync_accounts_passthrough_rejects_agent',
                  task: 'sync_accounts',
                  skipped: false,
                  passed: false,
                  error: 'Validation failed with bearer sk_live_abcdefghijklmnop',
                },
              ],
            },
          ],
        },
      ],
      failures: [
        {
          track: 'error_handling',
          storyboard_id: 'billing_gate_dispatch',
          step_id: 'sync_accounts_passthrough_rejects_agent',
          step_title: 'Passthrough-only buyer agent submits billing: agent',
          task: 'sync_accounts',
          error: 'Validation failed',
          expected: 'Reject with BILLING_NOT_PERMITTED_FOR_AGENT',
          fix_command: 'npx adcp storyboard run ...',
          validation: {
            check: 'field_value',
            description: 'Per-account error code is BILLING_NOT_PERMITTED_FOR_AGENT',
            json_pointer: '/accounts/0/errors/0/code',
            expected: 'BILLING_NOT_PERMITTED_FOR_AGENT',
            actual: 'BILLING_NOT_SUPPORTED',
          },
        },
      ],
    });

    const diagnostics = extractFailingStepDiagnostics(result);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      storyboard_id: 'billing_gate_dispatch',
      phase_id: 'per_agent_gate_reject',
      step_id: 'sync_accounts_passthrough_rejects_agent',
      task: 'sync_accounts',
      error_text: '[redacted]',
    });
    expect(diagnostics[0].failed_validations_jsonb).toEqual([
      {
        check: 'field_value',
        description: 'Per-account error code is BILLING_NOT_PERMITTED_FOR_AGENT',
        json_pointer: '/accounts/0/errors/0/code',
        expected: 'BILLING_NOT_PERMITTED_FOR_AGENT',
        actual: 'BILLING_NOT_SUPPORTED',
        passed: false,
      },
    ]);
  });
});
