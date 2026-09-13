import { describe, expect, it } from 'vitest';
import { complianceResultToDbInput, type ComplianceResult } from '../../src/addie/services/compliance-testing.js';

const agentUrl = 'https://agent.example.test/mcp';
function result(steps: unknown[], completeness: 'complete' | 'timed_out' = 'complete'): ComplianceResult {
  return {
    agent_url: agentUrl, completeness, adcp_version: '3.1.20',
    agent_profile: { tools: [], adcp_build_version: 'test-build', library_version: 'seller-sdk-1' },
    overall_status: 'passing',
    tracks: [{ track: 'core', status: 'pass', duration_ms: 1,
      scenarios: [{ scenario: 'first/check', overall_passed: true, steps }] }],
    bundle_results: [{ kind: 'universal', id: 'core', storyboard_ids: ['first', 'second', 'third'], status: 'passing' }],
    summary: { headline: 'Assessment', tracks_passed: 1, tracks_failed: 0, tracks_partial: 0, tracks_skipped: 0 },
    observations: [], total_duration_ms: 1,
  } as unknown as ComplianceResult;
}

describe('hosted compliance publication policy', () => {
  it('uses completeness even when a timed-out run says passing and has no observations', () => {
    const input = complianceResultToDbInput(result([{ passed: true }], 'timed_out'), agentUrl, 'production');
    expect(input).toMatchObject({ completeness: 'timed_out', is_authoritative: false });
    expect(input.storyboard_statuses?.map(s => s.storyboard_id)).toEqual(['first', 'second', 'third']);
  });

  it('keeps a fixed selected storyboard denominator across rotated execution slices', () => {
    const first = result([{ passed: true }]);
    const second = result([{ passed: true }]);
    second.tracks[0].scenarios[0].scenario = 'second/check' as never;
    second.bundle_results![0].storyboard_ids.reverse();
    const inputs = [first, second].map(r => complianceResultToDbInput(r, agentUrl, 'production'));
    expect(inputs.map(input => input.storyboard_statuses?.length)).toEqual([3, 3]);
    expect(inputs[0].storyboard_statuses?.find(s => s.storyboard_id === 'second')?.status).toBe('untested');
    expect(inputs[1].storyboard_statuses?.find(s => s.storyboard_id === 'first')?.status).toBe('untested');
  });

  it('ignores misleading timeout observation text on a complete run', () => {
    const complete = result([{ passed: true }]);
    complete.observations = [{ message: 'Timeout budget reached', source: { code: 'timeout-budget-exceeded' } }] as never;
    expect(complianceResultToDbInput(complete, agentUrl, 'production').is_authoritative).toBe(true);
  });

  it('keeps explicitly targeted storyboard runs audit-only', () => {
    expect(complianceResultToDbInput(result([{ passed: true }]), agentUrl, 'production', 'owner_test', ['first']))
      .toMatchObject({ is_authoritative: false, replace_storyboard_statuses: false });
  });

});
