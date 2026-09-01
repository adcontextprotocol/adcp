import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/db/client.js', () => ({
  closeDatabase: vi.fn(),
  getPool: () => ({ query: poolQueryMock }),
  initializeDatabase: vi.fn(),
}));
vi.mock('../../src/config.js', () => ({ getDatabaseConfig: () => ({ connectionString: 'test' }) }));
vi.mock('../../src/services/verification-profile-shadow.js', () => ({
  VERIFICATION_PROFILE_SHADOW_POLICY_VERSION: 'verification-profiles-v1',
}));

import {
  buildDecisionGates,
  calculateCoveragePercent,
  parseHours,
  runAudit,
} from '../../src/scripts/audit-verification-profile-shadow.js';

describe('verification profile shadow audit', () => {
  beforeEach(() => poolQueryMock.mockReset());

  it('bounds eligible-only coverage and validates its window', () => {
    expect(calculateCoveragePercent(10, 11)).toBe(100);
    expect(calculateCoveragePercent(10, 9)).toBe(90);
    expect(calculateCoveragePercent(0, 4)).toBe(0);
    expect(parseHours([])).toBe(48);
    expect(() => parseHours(['--hours=721'])).toThrow('--hours must be between 1 and 720');
  });

  it('reports stability and evidence defects as blocking gates', () => {
    const decision = buildDecisionGates({
      eligible_agents: 4,
      assessed_agents: 4,
      window_hours: 48,
      policy_observation_age_hours: 48,
      agents_with_stable_two_or_more_decision_ready_runs: 3,
      flapping_agents: 1,
      incomplete_latest_runs: 0,
      latest_runs_missing_bundle_evidence: 0,
      failing_bundles: 0,
      incomplete_bundles: 0,
      unattributed_failures: 2,
      evidence_drift_agents: 1,
      public_passing_not_spec_passing: 1,
      active_badges_not_spec_passing: 1,
    });

    expect(decision.automatic_gates_pass).toBe(false);
    expect(decision.blocking_reasons).toEqual([
      'stable_repeat_observations',
      'failures_attributed',
    ]);
    expect(decision.manual_review_reasons).toEqual([
      'public_passing_not_spec_passing',
      'affected_active_or_degraded_badges',
      'evidence_changed_between_runs',
    ]);
  });

  it('accepts stable repeat evidence for at least 95% of eligible agents', () => {
    const decision = buildDecisionGates({
      eligible_agents: 20,
      assessed_agents: 19,
      window_hours: 48,
      policy_observation_age_hours: 49,
      agents_with_stable_two_or_more_decision_ready_runs: 19,
      flapping_agents: 0,
    });

    expect(decision.gates.coverage.pass).toBe(true);
    expect(decision.gates.stable_repeat_observations.pass).toBe(true);
    expect(decision.automatic_gates_pass).toBe(true);
  });

  it('blocks unresolved Sandbox bundle projection without treating raw partial outcomes as corrupt data', () => {
    const decision = buildDecisionGates({
      eligible_agents: 1,
      assessed_agents: 1,
      window_hours: 48,
      policy_observation_age_hours: 48,
      agents_with_stable_two_or_more_decision_ready_runs: 1,
      flapping_agents: 0,
      incomplete_bundles: 4,
      sandbox_unresolved_bundles: 1,
    });

    expect(decision.blocking_reasons).toEqual(['sandbox_bundle_projection_resolved']);
    expect(decision.manual_review_reasons).toContain('candidate_nonpassing_bundles');
  });

  it('restricts both sides of coverage to eligible agents', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{
        eligible_agents: 1,
        assessed_agents: 2,
        window_hours: 48,
        policy_observation_age_hours: 48,
        agents_with_stable_two_or_more_decision_ready_runs: 1,
        flapping_agents: 0,
      }],
    });

    const report = await runAudit(['--hours=48']);

    expect(report.coverage_percent).toBe(100);
    expect(poolQueryMock.mock.calls[0][0]).toContain('JOIN eligible e ON e.agent_url = s.agent_url');
    expect(poolQueryMock.mock.calls[0][0]).toContain('e.lifecycle_stage = s.lifecycle_stage');
    expect(poolQueryMock.mock.calls[0][0]).toContain('COUNT(e.agent_url)::int AS eligible_agents');
  });

  it('adds badge identity and per-agent blocking reasons to restricted output', async () => {
    poolQueryMock
      .mockResolvedValueOnce({
        rows: [{ eligible_agents: 1, assessed_agents: 1 }],
      })
      .mockResolvedValueOnce({
        rows: [{
          agent_url: 'https://seller.example.test/mcp',
          evaluated_at: '2026-09-01T12:00:00.000Z',
          sandbox_eligible: true,
          run_count: 2,
          decision_ready_run_count: 2,
          outcome_variant_count: 2,
          transition_count: 1,
          evidence_transition_count: 1,
          run_complete: true,
          bundle_evidence_present: true,
          failing_bundle_count: 0,
          incomplete_bundle_count: 0,
          unattributed_failure_count: 0,
          current_public_status: 'passing',
          proposed_spec_status: 'partial',
          mixed_controller_failure_phase_count: 0,
          active_badges: [{
            role: 'media-buy',
            adcp_version: '3.1',
            status: 'active',
            verification_modes: ['spec'],
          }],
        }, {
          agent_url: 'https://testing.example.test/mcp',
          evaluated_at: '2026-09-01T12:00:00.000Z',
          lifecycle_stage: 'testing',
          sandbox_eligible: false,
          run_count: 2,
          decision_ready_run_count: 2,
          outcome_variant_count: 1,
          transition_count: 0,
          evidence_transition_count: 0,
          run_complete: true,
          bundle_evidence_present: true,
          failing_bundle_count: 0,
          incomplete_bundle_count: 1,
          sandbox_unresolved_bundle_count: 3,
          unattributed_failure_count: 0,
          current_public_status: 'partial',
          proposed_spec_status: 'partial',
          proposed_sandbox_status: null,
          mixed_controller_failure_phase_count: 0,
          active_badges: [],
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          agent_url: 'https://legacy.example.test/mcp',
          role: 'media-buy',
          adcp_version: '3.1',
          status: 'active',
          verification_modes: ['spec', 'live'],
          lifecycle_stage: 'production',
          reason_flags: ['retired_live_mode', 'multiple_modes'],
        }],
      });

    const report = await runAudit(['--include-agents']);
    const agents = report.agents as Array<Record<string, unknown>>;

    expect(poolQueryMock.mock.calls[1][0]).toContain("'adcp_version', b.adcp_version");
    expect(poolQueryMock.mock.calls[0][0]).toContain("'spec' = ANY(b.verification_modes)");
    expect(poolQueryMock.mock.calls[0][0]).toContain("'sandbox' = ANY(b.verification_modes)");
    expect(agents[0].blocking_reasons).toEqual(['candidate_outcome_flapping']);
    expect(agents[0].review_reasons).toEqual([
      'public_passing_not_spec_passing',
      'evidence_changed_between_runs',
      'active_or_degraded_badge_affected',
    ]);
    expect(agents[0].active_badges).toEqual([
      expect.objectContaining({ role: 'media-buy', adcp_version: '3.1' }),
    ]);
    expect(agents[1].blocking_reasons).not.toContain('sandbox_bundle_projection_unresolved');
    expect(report.legacy_badge_cohort).toEqual([
      expect.objectContaining({
        agent_url: 'https://legacy.example.test/mcp',
        role: 'media-buy',
        adcp_version: '3.1',
        reason_flags: ['retired_live_mode', 'multiple_modes'],
      }),
    ]);
    expect(poolQueryMock.mock.calls[0][0]).toContain('AS evidence_fingerprint');
    expect(poolQueryMock.mock.calls[0][0]).toContain('AS evidence_transition_count');
    expect(poolQueryMock.mock.calls[0][0]).toContain('AS decision_ready_run_count');
  });

  it('labels an eligible endpoint without a shadow row as unassessed only', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ eligible_agents: 1, assessed_agents: 0 }] })
      .mockResolvedValueOnce({
        rows: [{
          agent_url: 'https://unassessed.example.test/mcp',
          lifecycle_stage: 'production',
          evaluated_at: null,
          run_count: null,
          run_complete: null,
          bundle_evidence_present: null,
          active_badges: [],
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const report = await runAudit(['--include-agents']);
    const agents = report.agents as Array<Record<string, unknown>>;

    expect(agents[0].blocking_reasons).toEqual(['not_assessed']);
    expect(agents[0].review_reasons).toEqual([]);
  });

  it('requires two decision-ready observations even when raw candidate outcomes match', () => {
    const decision = buildDecisionGates({
      eligible_agents: 1,
      assessed_agents: 1,
      window_hours: 48,
      policy_observation_age_hours: 48,
      agents_with_stable_two_or_more_decision_ready_runs: 0,
      flapping_agents: 0,
      incomplete_latest_runs: 0,
      latest_runs_missing_bundle_evidence: 0,
      sandbox_unresolved_bundles: 0,
      unattributed_failures: 0,
    });

    expect(decision.gates.stable_repeat_observations.pass).toBe(false);
    expect(decision.blocking_reasons).toContain('stable_repeat_observations');
  });

  it('refuses a decision before the current policy has observed for the requested window', () => {
    const decision = buildDecisionGates({
      window_hours: 48,
      policy_observation_age_hours: 12,
      eligible_agents: 1,
      assessed_agents: 1,
      agents_with_stable_two_or_more_decision_ready_runs: 1,
      flapping_agents: 0,
    });

    expect(decision.gates.minimum_observation_window.pass).toBe(false);
    expect(decision.blocking_reasons).toContain('minimum_observation_window');
  });
});
