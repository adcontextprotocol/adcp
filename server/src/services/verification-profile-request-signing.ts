import type { ComplianceResult, TestStepResult } from '@adcp/sdk/testing';
import { record } from './verification-profile-tool-obligations.js';

/**
 * signed_requests "runs for any agent advertising `request_signing.supported:
 * true`"; for any other agent "absence of advertisement is not a failure"
 * (signed-requests.yaml). The runner then reports its `request_signer`
 * requirement unmet, which the SDK grades partial on every release. Every
 * other unmet requirement, test-kit gap or fixture gap stays a coverage gap
 * (runner-output-contract.yaml > skip_result).
 */
export const SIGNED_REQUESTS_STORYBOARD = 'signed_requests';

/** Synthetic phase and step the runner emits for an unmet storyboard requirement. */
const REQUIREMENT_GATE_PHASE = 'requirement_unmet';
const REQUEST_SIGNER_REQUIREMENT = 'request_signer';
const REQUEST_SIGNER_GATE_STEP = `${REQUIREMENT_GATE_PHASE}:${REQUEST_SIGNER_REQUIREMENT}`;
const NOT_APPLICABLE_SKIP = 'not_applicable';

const STORYBOARD_ASSERTION_FAILED = 'storyboard-assertion-failed';

function projectedPhases(result: ComplianceResult, storyboardId: string) {
  const prefix = `${storyboardId}/`;
  return (result.tracks ?? [])
    .flatMap(track => track.scenarios ?? [])
    .filter(({ scenario }) => typeof scenario === 'string'
      && scenario.startsWith(prefix)
      && !scenario.slice(prefix.length).includes('/'));
}

function hasFailureEvidence(result: ComplianceResult, storyboardId: string): boolean {
  if ((result.failures ?? []).some(failure => failure.storyboard_id === storyboardId)) return true;
  return (result.observations ?? []).some(({ source }) =>
    source?.code === STORYBOARD_ASSERTION_FAILED
    && 'storyboard_id' in source
    && source.storyboard_id === storyboardId);
}

/** Whether the storyboard's only result is the runner's unmet-signer row. */
function onlyUnmetSignerRow(result: ComplianceResult, storyboardId: string): boolean {
  const phases = projectedPhases(result, storyboardId);
  if (phases.length !== 1) return false;
  const [phase] = phases;
  if (phase.scenario !== `${storyboardId}/${REQUIREMENT_GATE_PHASE}` || !phase.overall_passed) return false;
  if (phase.steps?.length !== 1) return false;
  const [step]: TestStepResult[] = phase.steps;
  return step.skipped === true
    && step.passed === true
    && (step.validations?.length ?? 0) === 0
    && step.step_id === REQUEST_SIGNER_GATE_STEP
    && step.skip_reason === NOT_APPLICABLE_SKIP
    && step.requirement === REQUEST_SIGNER_REQUIREMENT;
}

/**
 * Whether the runner executed signed_requests and set it aside only because
 * the agent does not advertise request signing. False whenever the
 * declarations or the projected result cannot prove it, so callers fail
 * closed.
 */
export function requestSigningNotAdvertised(result: ComplianceResult): boolean {
  const storyboardId = SIGNED_REQUESTS_STORYBOARD;
  const capabilities = record(result.agent_profile?.raw_capabilities);
  if (!capabilities || record(capabilities.request_signing)?.supported === true) return false;
  if (!(result.storyboards_executed ?? []).includes(storyboardId)) return false;
  if ((result.storyboards_missing_tools ?? []).includes(storyboardId)) return false;
  return !hasFailureEvidence(result, storyboardId) && onlyUnmetSignerRow(result, storyboardId);
}
