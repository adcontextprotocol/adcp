import { describe, expect, it } from 'vitest';
import { complianceResultToDbInput, type ComplianceResult } from '../../src/addie/services/compliance-testing.js';
import { classifyComplianceStep } from '../../src/compliance/step-disposition.js';

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

  it.each(['complete', 'timed_out'] as const)('normalizes and prepares %s runs for persistence with observations omitted', completeness => {
    const run = result([{ passed: true }], completeness);
    delete (run as Partial<ComplianceResult>).observations;
    run.tracks[0].status = 'fail';
    const input = complianceResultToDbInput(run, agentUrl, 'production');
    expect(input).toMatchObject({ completeness, is_authoritative: completeness === 'complete',
      overall_status: 'passing', tracks_passed: 1, tracks_failed: 0, observations_json: undefined });
    expect(input.tracks_json[0].status).toBe('pass');
    expect(input.storyboard_statuses?.[0]).toMatchObject({ status: 'passing', steps_total: 1 });
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

  it.each([
    'not_applicable', 'transport_ungradable', 'grader_skipped',
    'capability_profile_mismatch', 'mcp_mode_flattens_url_edges', 'oauth_not_advertised',
    'rate_limit_not_triggered', 'force_scenario_unsupported', 'fixture_seed_unsupported',
    'fixture_unsatisfied', 'capability_unsupported', 'capability_prerequisite_unavailable',
  ])('never grades %s as an agent failure, independently of diagnostic text', skip_reason => {
    const input = complianceResultToDbInput(result([{ passed: false, skipped: true, skip_reason, error: 'failure' }]), agentUrl, 'production');
    expect(input.storyboard_statuses?.[0]).toMatchObject({ status: 'untested', steps_total: 0 });
    expect(input.tracks_failed).toBe(0);
  });

  it('neutralizes only the synthetic missing-tool gate, keeping production tasks failing', () => {
    const step = { passed: false, skipped: true, skip_reason: 'missing_tool' };
    expect(classifyComplianceStep(step, 'first/missing_tool')).toBe('not_applicable');
    expect(classifyComplianceStep({ ...step, step_id: 'missing_tool' }, 'first/missing_tool')).toBe('not_applicable');
    expect(classifyComplianceStep({ ...step, step_id: 'production_task' }, 'first/missing_tool')).toBe('failed');
    expect(classifyComplianceStep(step, 'first/check')).toBe('failed');
    expect(complianceResultToDbInput(result([step]), agentUrl, 'production').storyboard_statuses?.[0].status).toBe('failing');
  });

  it('uses pinned requires_tool metadata rather than identical missing-tool warning text', () => {
    const warning = 'Required tool "sync_governance" not advertised';
    const optional = result([{ passed: true, skipped: true, skip_reason: 'missing_tool',
      step_id: 'sync_governance', task: 'sync_governance', warnings: [warning] }]);
    optional.bundle_results = undefined;
    optional.tracks[0].scenarios[0].scenario = 'media_buy_seller/governance_setup' as never;
    const optionalInput = complianceResultToDbInput(optional, agentUrl, 'production');
    expect(optionalInput.storyboard_statuses?.[0].status).toBe('untested');
    expect(optionalInput.tracks_json[0]).toMatchObject({ status: 'skip', has_coverage_gap_skip: false });
    expect(optionalInput.tracks_passed).toBe(0);
    expect(optionalInput.overall_status).not.toBe('passing');
    const production = result([{ passed: true, skipped: true, skip_reason: 'missing_tool',
      step_id: 'required_production_task', task: 'get_products', warnings: [warning] }]);
    expect(complianceResultToDbInput(production, agentUrl, 'production').storyboard_statuses?.[0].status).toBe('failing');
    expect(complianceResultToDbInput(production, agentUrl, 'production').tracks_json[0].has_coverage_gap_skip).toBe(false);

    optional.tracks.push(result([{ passed: true }]).tracks[0]);
    const mixedInput = complianceResultToDbInput(optional, agentUrl, 'production');
    expect(mixedInput.overall_status).toBe('passing');
    expect(mixedInput.tracks_passed).toBe(1);
  });

  it('keeps controller prerequisites neutral when the exact pinned step itself requires the absent controller', () => {
    const run = result([
      { passed: true, skipped: true, skip_reason: 'missing_test_controller', step_id: 'force_upstream_unavailable', task: 'comply_test_controller' },
      { passed: false, skipped: true, skip_reason: 'prerequisite_failed', step_id: 'stale_response_wire_placement', task: 'get_products', warnings: [] },
    ]);
    run.bundle_results = undefined;
    run.tracks[0].scenarios[0].scenario = 'stale_response_advisory/stale_response_forcing' as never;
    expect(complianceResultToDbInput(run, agentUrl, 'production').storyboard_statuses?.[0])
      .toMatchObject({ status: 'untested', steps_total: 0 });
    expect(complianceResultToDbInput(run, agentUrl, 'production').tracks_json[0])
      .toMatchObject({ status: 'skip', has_coverage_gap_skip: true });
    expect(complianceResultToDbInput(run, agentUrl, 'production').overall_status).not.toBe('passing');
  });

  it('keeps nested storyboard failures in their selected denominator and isolates sibling fixture gaps', () => {
    const run = result([{ skipped: true, skip_reason: 'fixture_unavailable' }]);
    run.tracks[0].scenarios[0].scenario = 'media_buy_seller/fixture_setup/check' as never;
    run.tracks[0].scenarios.push({ scenario: 'media_buy_seller/available_actions/discover_product_action_template',
      overall_passed: false, steps: [
        { step: 'Required production call', passed: false, skipped: true, skip_reason: 'prerequisite_failed' },
      ] } as never);
    run.bundle_results![0].storyboard_ids = ['media_buy_seller/fixture_setup', 'media_buy_seller/available_actions'];
    const input = complianceResultToDbInput(run, agentUrl, 'production');
    expect(input.storyboard_statuses).toEqual([
      expect.objectContaining({ storyboard_id: 'media_buy_seller/available_actions', status: 'failing', steps_total: 1 }),
      expect.objectContaining({ storyboard_id: 'media_buy_seller/fixture_setup', status: 'untested', steps_total: 0 }),
    ]);
    expect(input.overall_status).not.toBe('passing');
  });

  it('prefers canonical not_applicable over a future detailed reason', () => {
    expect(classifyComplianceStep({ skipped: true, skip_reason: 'new_reason', skip: { reason: 'not_applicable' } }))
      .toBe('not_applicable');
  });

  it('retains genuine dependency failures after a passed producer and unrelated neutral skip', () => {
    const input = complianceResultToDbInput(result([
      { passed: true, task: 'get_products' },
      { skipped: true, skip_reason: 'missing_test_controller' },
      { passed: false, skipped: true, skip_reason: 'prerequisite_failed', warnings: [] },
    ]), agentUrl, 'production');
    expect(input.storyboard_statuses?.[0]).toMatchObject({ status: 'partial', steps_total: 2, steps_passed: 1, skipped_count: 1 });
    expect(input.overall_status).not.toBe('passing');
  });

  it('keeps controller seeding and its cascades as setup gaps, but retains real controller failures', () => {
    expect(classifyComplianceStep({ passed: false, task: 'comply_test_controller' }, 'first/__controller_seeding__')).toBe('setup_gap');
    expect(classifyComplianceStep({ skipped: true, skip_reason: 'controller_seeding_failed' })).toBe('setup_gap');
    expect(classifyComplianceStep({ passed: false, task: 'comply_test_controller' }, 'first/check')).toBe('failed');
    expect(classifyComplianceStep({ skipped: true, skip_reason: 'requirement_unmet', requirement: 'request_signer' })).toBe('setup_gap');
  });

  it('does not promote a skipped dependency track beside a healthy track', () => {
    const run = result([{ passed: true }]);
    run.tracks.push({ ...run.tracks[0], track: 'signals', status: 'skip', scenarios: [{
      ...run.tracks[0].scenarios[0], scenario: 'second/check' as never, overall_passed: false,
      steps: [{ passed: false, skipped: true, skip_reason: 'prerequisite_failed' }],
    }] } as never);
    expect(complianceResultToDbInput(run, agentUrl, 'production').overall_status).not.toBe('passing');
  });

  it('retains detached assertion failures when controller setup is neutralized', () => {
    // rc.33 projects the seeding title into step and drops step_id.
    const run = result([{ step: 'Seed account fixture-account', passed: false,
      task: 'comply_test_controller', error: 'Setup unavailable' }]);
    run.tracks[0].scenarios[0].scenario = 'first/__controller_seeding__' as never;
    run.tracks[0].scenarios[0].overall_passed = false;
    run.tracks[0].status = 'fail';
    run.observations = [{ track: 'core', severity: 'error', source: {
      kind: 'storyboard', code: 'storyboard-assertion-failed', storyboard_id: 'first',
    } }] as never;
    const input = complianceResultToDbInput(run, agentUrl, 'production');
    expect(input.overall_status).toBe('failing');
    expect(input.storyboard_statuses?.[0]).toMatchObject({ status: 'failing', failure_count: 1 });
    expect(input.step_diagnostics).toEqual([expect.objectContaining({
      phase_id: '__controller_seeding__', task: 'comply_test_controller',
      error_text: 'Setup unavailable', step_passed: false,
    })]);
  });

  it('records exact runner and agent provenance, leaving absent agent builds null', () => {
    const run = result([{ passed: true }]);
    expect(complianceResultToDbInput(run, agentUrl, 'production').provenance_json).toMatchObject({
      compliance_bundle_version: '3.1.20', sdk_version: '14.0.0-rc.40',
      agent_build_version: 'test-build', agent_library_version: 'seller-sdk-1',
    });
    delete run.agent_profile.adcp_build_version;
    expect(complianceResultToDbInput(run, agentUrl, 'production').provenance_json?.agent_build_version).toBeNull();
  });
});
