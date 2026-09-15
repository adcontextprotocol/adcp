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
  getLatestVerificationProfileAssessment,
  pruneVerificationProfileShadowAssessments,
  recordVerificationProfileShadowAssessment,
} from '../../src/db/verification-profile-shadow-db.js';

describe('recordVerificationProfileShadowAssessment', () => {
  beforeEach(() => {
    queryMock.mockReset().mockResolvedValue({ rows: [{ source_run_id: 'run-1' }], rowCount: 1 });
    deadlineMock.mockClear();
  });

  it('writes an immutable bounded assessment bound to its authoritative source run', async () => {
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
        flat_failure_count: 0,
        unattributed_flat_failure_count: 0,
        unexplained_phase_failure_count: 0,
        sandbox_unresolved_executed_bundle_count: 0,
        sandbox_unresolved_missing_tools_bundle_count: 0,
        sandbox_unresolved_unknown_bundle_count: 0,
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
    expect(queryMock.mock.calls[0][0]).toContain('ON CONFLICT (source_run_id) DO NOTHING');
    expect(queryMock.mock.calls[0][0]).toContain('AND agent_url = $2');
    expect(queryMock.mock.calls[0][0]).toContain('AND lifecycle_stage = $3');
    expect(queryMock.mock.calls[0][0]).toContain('AND adcp_version IS NOT DISTINCT FROM $4');
    expect(queryMock.mock.calls[0][0]).toContain('FROM system_settings');
    expect(queryMock.mock.calls[0][0]).toContain(
      `value = '{"enabled": true, "expires_at": null}'::jsonb`,
    );
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
      0,
      0,
      0,
      0,
      0,
      0,
      'verification_profile_shadow_rollout',
    ]);
  });

  it('returns the latest current-policy authoritative complete comparison', async () => {
    const row = { source_run_id: 'run-2', adcp_version: '3.1' };
    queryMock.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    await expect(getLatestVerificationProfileAssessment(
      'https://seller.example.test/mcp',
      'verification-profiles-v3',
    )).resolves.toEqual(row);

    expect(queryMock.mock.calls[0][0]).toContain('r.is_authoritative = TRUE');
    expect(queryMock.mock.calls[0][0]).toContain("r.completeness = 'complete'");
    expect(queryMock.mock.calls[0][0]).toContain('r.agent_url = s.agent_url');
    expect(queryMock.mock.calls[0][0]).toContain('r.lifecycle_stage = s.lifecycle_stage');
    expect(queryMock.mock.calls[0][0]).toContain('r.adcp_version IS NOT DISTINCT FROM s.adcp_version');
    expect(queryMock.mock.calls[0][0]).toContain('LIMIT 1');
    expect(queryMock.mock.calls[0][1]).toEqual([
      'https://seller.example.test/mcp',
      'verification-profiles-v3',
    ]);
    expect(deadlineMock).toHaveBeenCalledWith(expect.any(Number), expect.any(Function), { readOnly: true });
  });

  it('returns null when no comparison exists', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(getLatestVerificationProfileAssessment(
      'https://seller.example.test/mcp',
      'verification-profiles-v3',
    )).resolves.toBeNull();
  });

  it('exposes the fixed-retention pruning procedure', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ pruned_count: '7' }] });

    await expect(pruneVerificationProfileShadowAssessments()).resolves.toBe(7);

    expect(queryMock.mock.calls[0][0]).toContain('prune_verification_profile_shadow_assessments()');
    expect(deadlineMock).toHaveBeenCalledWith(expect.any(Number), expect.any(Function), { readOnly: false });
  });
});
