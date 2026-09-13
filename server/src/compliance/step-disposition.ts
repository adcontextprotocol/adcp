/** Hosted grading policy over SDK output; never derive a verdict from diagnostic prose. */
export type StepDisposition = 'passed' | 'failed' | 'not_applicable' | 'setup_gap' | 'dependency_failed';

type GradedStep = {
  passed?: boolean;
  skipped?: boolean;
  task?: string;
  step_id?: unknown;
  skip_reason?: string;
  requirement?: unknown;
  skip?: { reason?: string; requirement?: unknown };
};

// @adcp/sdk 14.0.0-rc.33 projects detailed reasons but omits canonical skip.reason.
// Keep this exact compatibility list aligned with its DETAILED_SKIP_TO_CANONICAL.
const NOT_APPLICABLE = new Set([
  'not_applicable', 'peer_branch_taken', 'peer_substituted',
  'probe_skipped', 'not_in_only_vectors', 'grader_skipped',
  'capability_profile_mismatch', 'transport_ungradable', 'mcp_mode_flattens_url_edges',
  'oauth_not_advertised', 'rate_limit_not_triggered', 'force_scenario_unsupported',
  'fixture_seed_unsupported', 'fixture_unsatisfied', 'capability_unsupported',
  'capability_prerequisite_unavailable',
]);
const SETUP_GAPS = new Set([
  'missing_test_controller', 'fixture_unavailable', 'unsatisfied_contract',
  'rate_abuse_opt_out', 'live_side_effect_opt_in_required',
  'operator_skip', 'controller_seeding_failed',
]);
export function classifyComplianceStep(step: GradedStep, scenario = ''): StepDisposition {
  // The synthetic seeding phase evaluates harness setup, not production behavior.
  // Retain its failed wire evidence separately for the owner/operator.
  if (scenario.endsWith('/__controller_seeding__') && step.task === 'comply_test_controller') {
    return step.passed && !step.skipped ? 'not_applicable' : 'setup_gap';
  }
  if (!step.skipped) return step.passed ? 'passed' : 'failed';
  const reason = step.skip?.reason ?? step.skip_reason;
  if (reason === 'missing_tool') {
    // rc.33 omits step_id in the synthetic projection. If a producer supplies
    // an identity, require it to agree with the reserved gate phase.
    const syntheticGate = scenario.endsWith('/missing_tool') &&
      (step.step_id === undefined || step.step_id === 'missing_tool');
    return syntheticGate ? 'not_applicable' : 'failed';
  }
  if (NOT_APPLICABLE.has(reason ?? '')) return 'not_applicable';
  // The detailed seeding reason is more specific than canonical prerequisite_failed.
  if (SETUP_GAPS.has(reason ?? '') || step.skip_reason === 'controller_seeding_failed') return 'setup_gap';
  const requirement = step.skip?.requirement ?? step.requirement;
  if (reason === 'requirement_unmet' && typeof requirement === 'string' && requirement.trim()) {
    return 'setup_gap';
  }
  // rc.33 drops causal IDs from ordinary prerequisite failures. A nearby neutral
  // skip is not proof: a passed producer may still have omitted required state.
  if (reason === 'prerequisite_failed') return 'dependency_failed';
  return 'failed';
}
