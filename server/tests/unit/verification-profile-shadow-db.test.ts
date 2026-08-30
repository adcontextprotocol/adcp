import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
const deadlineMock = vi.hoisted(() => vi.fn(
  async (_deadline: number, work: () => Promise<unknown>) => work(),
));
vi.mock('../../src/db/client.js', () => ({
  query: queryMock,
  withDatabaseDeadline: deadlineMock,
}));

import {
  pruneVerificationProfileShadowAssessments,
  recordVerificationProfileShadowAssessment,
} from '../../src/db/verification-profile-shadow-db.js';

describe('recordVerificationProfileShadowAssessment', () => {
  beforeEach(() => {
    queryMock.mockReset().mockResolvedValue({ rows: [{ source_run_id: 'run-1' }], rowCount: 1 });
    deadlineMock.mockClear();
  });

  it('writes an idempotent bounded assessment bound to its source run', async () => {
    await expect(recordVerificationProfileShadowAssessment({
      sourceRunId: 'run-1',
      agentUrl: 'https://seller.example.test/mcp',
      lifecycleStage: 'production',
      adcpVersion: '3.1',
      assessment: {
        policy_version: 'verification-profiles-v1',
        current_public_status: 'passing',
        proposed_spec_status: 'partial',
        proposed_sandbox_status: 'passing',
        sandbox_eligible: true,
        recommended_profile: 'sandbox',
        run_complete: true,
        bundle_evidence_present: true,
        failing_bundle_count: 0,
        incomplete_bundle_count: 0,
        sandbox_unresolved_bundle_count: 0,
        unattributed_failure_count: 0,
        selected_storyboard_count: 12,
        applicable_phase_count: 10,
        controller_gap_phase_count: 2,
        controller_gap_step_count: 2,
        controller_cascade_step_count: 3,
        observed_failure_count: 0,
        sandbox_observable_failure_count: 0,
        non_controller_gap_step_count: 0,
        controller_missing_storyboard_count: 1,
        other_missing_storyboard_count: 0,
        mixed_controller_failure_phase_count: 0,
      },
    })).resolves.toBe(true);

    expect(queryMock).toHaveBeenCalledOnce();
    expect(deadlineMock).toHaveBeenCalledWith(expect.any(Number), expect.any(Function), { readOnly: false });
    expect(queryMock.mock.calls[0][0]).toContain('ON CONFLICT (source_run_id) DO UPDATE');
    expect(queryMock.mock.calls[0][0]).toContain('FOR SHARE');
    expect(queryMock.mock.calls[0][0]).toContain("value->>'enabled' = 'true'");
    expect(queryMock.mock.calls[0][1]).toEqual([
      'run-1',
      'https://seller.example.test/mcp',
      'production',
      '3.1',
      'verification-profiles-v1',
      'passing',
      'partial',
      'passing',
      true,
      'sandbox',
      true,
      true,
      0,
      0,
      0,
      0,
      12,
      10,
      2,
      2,
      3,
      0,
      0,
      0,
      1,
      0,
      0,
      'verification_profile_shadow_rollout',
    ]);
  });

  it('does not write when the rollout lease was disabled before the atomic insert', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(recordVerificationProfileShadowAssessment({
      sourceRunId: 'run-disabled',
      agentUrl: 'https://seller.example.test/mcp',
      lifecycleStage: 'production',
      assessment: {
        policy_version: 'verification-profiles-v1',
        current_public_status: 'passing',
        proposed_spec_status: 'passing',
        proposed_sandbox_status: 'passing',
        sandbox_eligible: true,
        recommended_profile: 'spec',
        run_complete: true,
        bundle_evidence_present: true,
        failing_bundle_count: 0,
        incomplete_bundle_count: 0,
        sandbox_unresolved_bundle_count: 0,
        unattributed_failure_count: 0,
        selected_storyboard_count: 1,
        applicable_phase_count: 1,
        controller_gap_phase_count: 0,
        controller_gap_step_count: 0,
        controller_cascade_step_count: 0,
        observed_failure_count: 0,
        sandbox_observable_failure_count: 0,
        non_controller_gap_step_count: 0,
        controller_missing_storyboard_count: 0,
        other_missing_storyboard_count: 0,
        mixed_controller_failure_phase_count: 0,
      },
    })).resolves.toBe(false);
  });

  it('exposes the fixed-retention pruning procedure', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ pruned_count: '7' }] });

    await expect(pruneVerificationProfileShadowAssessments()).resolves.toBe(7);

    expect(queryMock.mock.calls[0][0]).toContain('prune_verification_profile_shadow_assessments()');
    expect(deadlineMock).toHaveBeenCalledWith(expect.any(Number), expect.any(Function), { readOnly: false });
  });
});
