import type { ComplianceResult } from '@adcp/sdk/testing';
import type {
  BadgeRole,
  LifecycleStage,
  StoryboardStatusEntry,
} from '../db/compliance-db.js';
import { deriveVerificationStatus } from '../addie/services/compliance-testing.js';
import {
  agentAdvertisesBadgeEligibleHostedComplianceTarget,
  badgeEligibleVersionsForHostedComplianceTarget,
  hostedComplianceTarget,
} from './hosted-compliance-version.js';

export const VERIFICATION_PROFILE_ROLE_POLICY_VERSION = 'verification-profiles-role-v1';

export type GradingProfile = 'legacy' | 'spec' | 'sandbox';
export type GradingStatus = 'passing' | 'partial' | 'failing';

export interface VerificationProfileRoleAssessmentInput {
  role: BadgeRole;
  adcp_version: string;
  grading_profile: GradingProfile;
  status: GradingStatus | null;
  selectable: boolean;
  policy_version: string;
  compliance_bundle_version: string;
  requested_compliance_target: string | null;
  lifecycle_stage: LifecycleStage;
  run_complete: boolean;
  evidence: Record<string, unknown>;
}

function badgeEligibleRelease(input: {
  result: ComplianceResult;
  requestedComplianceTarget?: string | null;
}): string | null {
  const requestedTarget = input.requestedComplianceTarget?.trim();
  if (!requestedTarget) return null;

  try {
    const target = hostedComplianceTarget(requestedTarget);
    const [release] = badgeEligibleVersionsForHostedComplianceTarget(target);
    if (!release) return null;

    const observedRelease = input.result.adcp_version
      ?.match(/^([1-9][0-9]*\.[0-9]+)(?:\.[0-9]+)?$/)?.[1];
    if (observedRelease !== release) return null;

    return agentAdvertisesBadgeEligibleHostedComplianceTarget(
      input.result.agent_profile?.adcp_supported_versions,
      target,
    ) ? release : null;
  } catch {
    return null;
  }
}

function legacyStatus(role: ReturnType<typeof deriveVerificationStatus>['roles'][number]): GradingStatus {
  if (role.verified) return 'passing';
  if (role.untested.length > 0) return 'partial';
  return 'failing';
}

/**
 * Produce exact role/version profile evidence from one authoritative full run.
 * Legacy deliberately delegates to the existing badge evaluator. Strict Spec
 * additionally requires complete universal, role-protocol, and every declared
 * stable-specialism bundle. Unattributed failures fail every role closed.
 * Sandbox remains visible but unavailable until causal bundle evidence ships.
 */
export function deriveVerificationProfileRoleAssessments(input: {
  result: ComplianceResult;
  lifecycleStage: LifecycleStage;
  requestedComplianceTarget?: string | null;
  storyboardStatuses: StoryboardStatusEntry[];
}): VerificationProfileRoleAssessmentInput[] {
  // Public profile selection follows the same eligibility contract as badge
  // issuance: only a stable supported line explicitly requested for the run
  // and advertised by the agent may produce enforceable evidence. Exact
  // bundle and prerelease diagnostic targets remain audit-only.
  const release = badgeEligibleRelease(input);
  if (!release) return [];

  const verification = deriveVerificationStatus(
    input.result.agent_profile?.specialisms ?? [],
    input.storyboardStatuses,
  );
  const bundles = input.result.bundle_results ?? [];
  const failures = input.result.failures ?? [];
  const allBundledStoryboardIds = new Set(bundles.flatMap(bundle => bundle.storyboard_ids ?? []));
  const runComplete = input.result.completeness === 'complete';
  const output: VerificationProfileRoleAssessmentInput[] = [];

  for (const role of verification.roles) {
    const relevantBundles = bundles.filter(bundle =>
      bundle.kind === 'universal'
      || (bundle.kind === 'protocol' && bundle.id === role.role)
      || (bundle.kind === 'specialism' && role.specialisms.includes(bundle.id)),
    );
    const relevantStoryboardIds = new Set(relevantBundles.flatMap(bundle => bundle.storyboard_ids ?? []));
    const relevantFailures = failures.filter(failure =>
      !failure.storyboard_id
      || relevantStoryboardIds.has(failure.storyboard_id)
      || !allBundledStoryboardIds.has(failure.storyboard_id),
    );
    const missingProtocolBundle = !relevantBundles.some(bundle =>
      bundle.kind === 'protocol' && bundle.id === role.role,
    );
    const missingSpecialismBundles = role.specialisms.filter(specialism =>
      !relevantBundles.some(bundle => bundle.kind === 'specialism' && bundle.id === specialism),
    );
    const missingUniversalBundle = !relevantBundles.some(bundle => bundle.kind === 'universal');
    const failingBundles = relevantBundles.filter(bundle => bundle.status === 'failing');
    const incompleteBundles = relevantBundles.filter(bundle =>
      bundle.status === 'partial' || bundle.status === 'untested',
    );

    const exactLegacyStatus = legacyStatus(role);
    let specStatus: GradingStatus;
    if (
      exactLegacyStatus === 'failing'
      || failingBundles.length > 0
      || relevantFailures.length > 0
    ) {
      specStatus = 'failing';
    } else if (
      exactLegacyStatus !== 'passing'
      || !runComplete
      || missingUniversalBundle
      || missingProtocolBundle
      || missingSpecialismBundles.length > 0
      || incompleteBundles.length > 0
      || relevantBundles.length === 0
    ) {
      specStatus = 'partial';
    } else {
      specStatus = 'passing';
    }

    const evidence = {
      specialisms: role.specialisms,
      relevant_bundle_count: relevantBundles.length,
      relevant_bundle_ids: relevantBundles.map(bundle => `${bundle.kind}:${bundle.id}`),
      failing_bundle_count: failingBundles.length,
      incomplete_bundle_count: incompleteBundles.length,
      relevant_failure_count: relevantFailures.length,
      missing_universal_bundle: missingUniversalBundle,
      missing_protocol_bundle: missingProtocolBundle,
      missing_specialism_bundles: missingSpecialismBundles,
    };
    const common = {
      role: role.role,
      adcp_version: release,
      policy_version: VERIFICATION_PROFILE_ROLE_POLICY_VERSION,
      compliance_bundle_version: input.result.adcp_version!,
      requested_compliance_target: input.requestedComplianceTarget ?? null,
      lifecycle_stage: input.lifecycleStage,
      run_complete: runComplete,
    };
    output.push(
      {
        ...common,
        grading_profile: 'legacy',
        status: exactLegacyStatus,
        selectable: true,
        evidence: { ...evidence, evaluator: 'legacy-specialism-parity' },
      },
      {
        ...common,
        grading_profile: 'spec',
        status: specStatus,
        selectable: true,
        evidence: { ...evidence, evaluator: 'strict-complete-bundles' },
      },
      {
        ...common,
        grading_profile: 'sandbox',
        status: null,
        selectable: false,
        evidence: {
          ...evidence,
          evaluator: 'sandbox-preview-blocked',
          unavailable_reason: 'Causal bundle data and a public versioned exception catalog are required.',
        },
      },
    );
  }

  return output;
}
