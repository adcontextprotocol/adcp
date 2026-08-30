import type { ComplianceResult, Storyboard, TestStepResult } from '@adcp/sdk/testing';
import type { LifecycleStage, OverallRunStatus } from '../db/compliance-db.js';
import { getStoryboardsForVersion } from './storyboards.js';

export const VERIFICATION_PROFILE_SHADOW_POLICY_VERSION = 'verification-profiles-v1';

export type ShadowCandidateStatus = 'passing' | 'partial' | 'failing';
export type ShadowRecommendedProfile = 'spec' | 'sandbox' | null;

export interface VerificationProfileShadowAssessment {
  policy_version: string;
  current_public_status: ShadowCandidateStatus;
  proposed_spec_status: ShadowCandidateStatus;
  proposed_sandbox_status: ShadowCandidateStatus | null;
  sandbox_eligible: boolean;
  recommended_profile: ShadowRecommendedProfile;
  run_complete: boolean;
  bundle_evidence_present: boolean;
  selected_storyboard_count: number;
  applicable_phase_count: number;
  controller_gap_phase_count: number;
  controller_gap_step_count: number;
  controller_cascade_step_count: number;
  observed_failure_count: number;
  sandbox_observable_failure_count: number;
  non_controller_gap_step_count: number;
  controller_missing_storyboard_count: number;
  other_missing_storyboard_count: number;
  mixed_controller_failure_phase_count: number;
  failing_bundle_count: number;
  incomplete_bundle_count: number;
  sandbox_unresolved_bundle_count: number;
  unattributed_failure_count: number;
}

type ShadowStep = TestStepResult & {
  requirement?: string;
  skip?: { detail?: unknown };
};

type ScenarioIdentity = {
  storyboardId: string | null;
  phaseId: string | null;
};

function candidateStatus(status: ComplianceResult['overall_status'] | OverallRunStatus): ShadowCandidateStatus {
  if (status === 'passing') return 'passing';
  if (status === 'partial') return 'partial';
  return 'failing';
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const nested = value.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
      if (nested) return nested.trim();
    }
  }
  return undefined;
}

function isDirectControllerGap(step: ShadowStep): boolean {
  return step.skipped === true && (
    step.skip_reason === 'missing_test_controller' ||
    (step.skip_reason === 'requirement_unmet' && step.requirement === 'controller')
  );
}

function isControllerCascade(step: ShadowStep): boolean {
  if (step.skipped !== true || step.skip_reason !== 'prerequisite_failed') return false;
  const detail = firstText(step.skip?.detail, step.details, step.error, step.warnings);
  return detail?.includes('skipped (missing_test_controller)') === true;
}

function isNeutralNonControllerSkip(step: ShadowStep): boolean {
  if (!step.skipped) return false;
  if (step.skip_reason === 'peer_branch_taken' || step.skip_reason === 'peer_substituted') return true;
  if (step.skip_reason === 'not_applicable' || step.skip_reason === 'capability_unsupported') return true;
  // Keep this allowlist aligned with the public compliance summarizer. Other
  // requirement names include seeded state, required tool families, and
  // forward-compatible runtime gates; treating those as neutral would promote
  // evidence the runner never observed.
  return step.skip_reason === 'requirement_unmet' && step.requirement === 'webhook_receiver';
}

const catalogByVersion = new Map<string, readonly Storyboard[]>();

function catalogForResult(result: ComplianceResult): readonly Storyboard[] {
  const exact = result.adcp_version;
  if (!exact) return [];
  const cached = catalogByVersion.get(exact);
  if (cached) return cached;

  let catalog: readonly Storyboard[] = [];
  try {
    catalog = getStoryboardsForVersion(exact);
  } catch {
    // Unknown exact-cache evidence remains ambiguous and cannot justify a
    // Sandbox exclusion. Never substitute another release's storyboard set.
  }
  catalogByVersion.set(exact, catalog);
  return catalog;
}

function scenarioIdentity(
  scenario: unknown,
  knownStoryboardIds: readonly string[],
): ScenarioIdentity {
  if (typeof scenario !== 'string') return { storyboardId: null, phaseId: null };
  const matched = knownStoryboardIds
    .filter((id) => scenario === id || scenario.startsWith(`${id}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (matched) {
    const phaseId = scenario === matched ? null : scenario.slice(matched.length + 1).split('/')[0] || null;
    return { storyboardId: matched, phaseId };
  }
  const separator = scenario.lastIndexOf('/');
  return separator > 0
    ? { storyboardId: scenario.slice(0, separator), phaseId: scenario.slice(separator + 1) || null }
    : { storyboardId: null, phaseId: null };
}

function storyboardRequiresController(storyboard: Storyboard): boolean {
  return storyboard.requires?.includes('controller') === true;
}

function phaseUsesController(storyboard: Storyboard, phaseId: string | null): boolean {
  if (storyboardRequiresController(storyboard)) return true;
  if (!phaseId) return false;
  return storyboard.phases
    .find((phase) => phase.id === phaseId)
    ?.steps.some((step) => step.task === 'comply_test_controller') === true;
}

function missingStoryboardIsControllerCaused(storyboard: Storyboard): boolean {
  if (storyboardRequiresController(storyboard)) return true;
  const requiredTools = storyboard.required_tools ?? [];
  // required_tools is an any-of applicability list. A record claiming that a
  // mixed list is missing while an ordinary member was advertised is
  // contradictory, not proof that only the controller was absent.
  return requiredTools.length > 0 && requiredTools.every((tool) => tool === 'comply_test_controller');
}

/**
 * Derive observation-only candidate profile outcomes from an already completed
 * compliance run. This function has no persistence or badge side effects.
 * It fails closed: absent bundle/completeness evidence and unknown skips remain
 * partial instead of being promoted to passing.
 */
export function deriveVerificationProfileShadowAssessment(
  result: ComplianceResult,
  lifecycleStage: LifecycleStage,
  publicOverallStatus: OverallRunStatus,
): VerificationProfileShadowAssessment {
  const catalog = catalogForResult(result);
  const storyboardById = new Map(catalog.map((storyboard) => [storyboard.id, storyboard]));
  const selectedStoryboardIds = new Set<string>();
  for (const bundle of result.bundle_results ?? []) {
    for (const id of bundle.storyboard_ids ?? []) selectedStoryboardIds.add(id);
  }
  for (const id of result.storyboards_executed ?? []) selectedStoryboardIds.add(id);
  for (const id of result.storyboards_not_applicable ?? []) selectedStoryboardIds.add(id);
  for (const id of result.storyboards_missing_tools ?? []) selectedStoryboardIds.add(id);
  const knownStoryboardIds = [...new Set([...storyboardById.keys(), ...selectedStoryboardIds])];

  let applicablePhaseCount = 0;
  let controllerGapPhaseCount = 0;
  let controllerGapStepCount = 0;
  let controllerCascadeStepCount = 0;
  let observedFailureCount = 0;
  let observedFailedStepCount = 0;
  let sandboxObservableFailureCount = 0;
  let nonControllerGapStepCount = 0;
  let mixedControllerFailurePhaseCount = 0;
  let unexplainedPhaseFailureCount = 0;
  for (const track of result.tracks ?? []) {
    for (const phase of track.scenarios ?? []) {
      const identity = scenarioIdentity(phase.scenario, knownStoryboardIds);
      if (identity.storyboardId) selectedStoryboardIds.add(identity.storyboardId);
      const storyboard = identity.storyboardId ? storyboardById.get(identity.storyboardId) : undefined;
      const catalogControllerPhase = storyboard
        ? phaseUsesController(storyboard, identity.phaseId)
        : false;
      const steps = (phase.steps ?? []) as ShadowStep[];
      const directGaps = steps.filter(isDirectControllerGap);
      const cascades = steps.filter(isControllerCascade);
      const inferredControllerPhase = directGaps.length > 0 || cascades.length > 0;
      const phaseFailures = steps.filter((step) => !step.skipped && step.passed === false).length;
      const phaseFailedWithoutStep = phase.overall_passed === false && phaseFailures === 0 && !inferredControllerPhase;
      controllerGapStepCount += directGaps.length;
      controllerCascadeStepCount += cascades.length;
      observedFailedStepCount += phaseFailures;
      observedFailureCount += phaseFailures + (phaseFailedWithoutStep ? 1 : 0);
      if (phaseFailedWithoutStep) unexplainedPhaseFailureCount++;

      if (inferredControllerPhase) {
        controllerGapPhaseCount++;
        // A catalog-proven missing-controller phase is outside Sandbox. When a
        // shared Production endpoint actually exposes the controller, the
        // phase executes and is graded normally under both profiles.
        if (!catalogControllerPhase) {
          nonControllerGapStepCount += directGaps.length + cascades.length;
          sandboxObservableFailureCount += phaseFailures;
          if (phaseFailures > 0) mixedControllerFailurePhaseCount++;
        }
        continue;
      }

      if (steps.length === 0) {
        applicablePhaseCount++;
        if (phase.overall_passed === false) sandboxObservableFailureCount++;
        continue;
      }

      if (steps.some((step) => !step.skipped)) applicablePhaseCount++;
      sandboxObservableFailureCount += phaseFailures;
      nonControllerGapStepCount += steps.filter(
        (step) => step.skipped && !isNeutralNonControllerSkip(step),
      ).length;
    }
  }

  const controllerOnlyMissing = new Set<string>();
  const missingStoryboards = new Set(result.storyboards_missing_tools ?? []);
  for (const storyboardId of missingStoryboards) {
    const storyboard = storyboardById.get(storyboardId);
    if (storyboard && missingStoryboardIsControllerCaused(storyboard)) {
      controllerOnlyMissing.add(storyboardId);
    }
  }
  const otherMissingStoryboardCount = [...missingStoryboards]
    .filter((id) => !controllerOnlyMissing.has(id)).length;
  const notApplicableStoryboards = new Set(result.storyboards_not_applicable ?? []);

  const bundleResults = result.bundle_results ?? [];
  const bundleEvidencePresent = bundleResults.length > 0;
  const failingBundles = bundleResults.filter((bundle) => bundle.status === 'failing');
  const incompleteBundles = bundleResults.filter(
    (bundle) => bundle.status === 'partial' || bundle.status === 'untested',
  );
  const sandboxBundleCanProjectPassing = (storyboardIds: string[]): boolean => {
    if (storyboardIds.length === 0) return false;
    // ComplianceResult preserves explicit missing/not-applicable storyboard
    // causes, but not every reason the SDK may have used to mark an executed
    // bundle partial. Project only when the entire partial bundle is explained
    // by those preserved causal fields. Mixed executed controller gaps remain
    // unresolved until the SDK exposes complete bundle/storyboard reason data.
    return storyboardIds.every((id) =>
      notApplicableStoryboards.has(id) || controllerOnlyMissing.has(id)) &&
      storyboardIds.some((id) => controllerOnlyMissing.has(id));
  };
  const sandboxFailingBundleCount = failingBundles.length;
  const sandboxIncompleteBundleCount = incompleteBundles.filter((bundle) =>
    !sandboxBundleCanProjectPassing(bundle.storyboard_ids ?? [])).length;

  const detachedFailureCount = Math.max(0, (result.failures?.length ?? 0) - observedFailedStepCount);
  const unattributedFailureCount = detachedFailureCount + unexplainedPhaseFailureCount;
  const runComplete = result.completeness === 'complete';
  const currentPublicStatus = candidateStatus(publicOverallStatus);
  const controllerExplainsPublicGap = controllerGapPhaseCount > 0 || controllerOnlyMissing.size > 0;

  let proposedSpecStatus: ShadowCandidateStatus;
  if (
    observedFailureCount > 0 ||
    detachedFailureCount > 0 ||
    failingBundles.length > 0 ||
    currentPublicStatus === 'failing'
  ) {
    proposedSpecStatus = 'failing';
  } else if (
    !runComplete ||
    !bundleEvidencePresent ||
    incompleteBundles.length > 0 ||
    controllerGapPhaseCount > 0 ||
    controllerOnlyMissing.size > 0 ||
    otherMissingStoryboardCount > 0
  ) {
    proposedSpecStatus = 'partial';
  } else {
    proposedSpecStatus = currentPublicStatus;
  }

  const sandboxEligible = lifecycleStage === 'production';
  let proposedSandboxStatus: ShadowCandidateStatus | null = null;
  if (sandboxEligible) {
    if (
      sandboxObservableFailureCount > 0 ||
      detachedFailureCount > 0 ||
      sandboxFailingBundleCount > 0
    ) {
      proposedSandboxStatus = 'failing';
    } else if (
      !runComplete ||
      !bundleEvidencePresent ||
      applicablePhaseCount === 0 ||
      sandboxIncompleteBundleCount > 0 ||
      nonControllerGapStepCount > 0 ||
      otherMissingStoryboardCount > 0 ||
      mixedControllerFailurePhaseCount > 0 ||
      (currentPublicStatus !== 'passing' && !controllerExplainsPublicGap)
    ) {
      proposedSandboxStatus = 'partial';
    } else {
      proposedSandboxStatus = 'passing';
    }
  }

  const recommendedProfile: ShadowRecommendedProfile = lifecycleStage === 'testing'
    ? 'spec'
    : proposedSpecStatus === 'passing'
      ? 'spec'
      : proposedSandboxStatus === 'passing'
        ? 'sandbox'
        : null;

  return {
    policy_version: VERIFICATION_PROFILE_SHADOW_POLICY_VERSION,
    current_public_status: currentPublicStatus,
    proposed_spec_status: proposedSpecStatus,
    proposed_sandbox_status: proposedSandboxStatus,
    sandbox_eligible: sandboxEligible,
    recommended_profile: recommendedProfile,
    run_complete: runComplete,
    bundle_evidence_present: bundleEvidencePresent,
    selected_storyboard_count: selectedStoryboardIds.size,
    applicable_phase_count: applicablePhaseCount,
    controller_gap_phase_count: controllerGapPhaseCount,
    controller_gap_step_count: controllerGapStepCount,
    controller_cascade_step_count: controllerCascadeStepCount,
    observed_failure_count: observedFailureCount,
    sandbox_observable_failure_count: sandboxObservableFailureCount,
    non_controller_gap_step_count: nonControllerGapStepCount,
    controller_missing_storyboard_count: controllerOnlyMissing.size,
    other_missing_storyboard_count: otherMissingStoryboardCount,
    mixed_controller_failure_phase_count: mixedControllerFailurePhaseCount,
    failing_bundle_count: failingBundles.length,
    incomplete_bundle_count: incompleteBundles.length,
    sandbox_unresolved_bundle_count: sandboxEligible ? sandboxIncompleteBundleCount : 0,
    unattributed_failure_count: unattributedFailureCount,
  };
}
