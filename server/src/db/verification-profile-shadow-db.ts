import { query, withDatabaseDeadline } from './client.js';
import type { LifecycleStage } from './compliance-db.js';
import type { VerificationProfileShadowAssessment } from '../services/verification-profile-shadow.js';
import { SETTING_KEYS } from './system-settings-db.js';

export interface StoredVerificationProfileAssessment extends VerificationProfileShadowAssessment {
  id: string;
  source_run_id: string;
  agent_url: string;
  lifecycle_stage: LifecycleStage;
  adcp_version: string;
  evaluated_at: Date;
  source_tested_at: Date;
  requested_compliance_target: string | null;
  source_provenance: Record<string, unknown> | null;
}

export async function recordVerificationProfileShadowAssessment(input: {
  sourceRunId: string;
  agentUrl: string;
  lifecycleStage: LifecycleStage;
  adcpVersion?: string | null;
  assessment: VerificationProfileShadowAssessment;
}): Promise<boolean> {
  const { assessment } = input;
  const result = await withDatabaseDeadline(Date.now() + 2_000, () => query(
    `WITH collection_enabled AS MATERIALIZED (
       SELECT 1
       FROM system_settings
       WHERE key = $34
         AND value = '{"enabled": true, "expires_at": null}'::jsonb
       FOR SHARE
     ), source_run AS MATERIALIZED (
       SELECT tested_at, requested_compliance_target
       FROM agent_compliance_runs
       WHERE id = $1
         AND agent_url = $2
         AND lifecycle_stage = $3
         AND adcp_version IS NOT DISTINCT FROM $4
         AND dry_run = FALSE
         AND is_authoritative = TRUE
         AND completeness = 'complete'
     )
     INSERT INTO verification_profile_shadow_assessments (
       source_run_id, agent_url, lifecycle_stage, adcp_version, policy_version,
       current_public_status, proposed_spec_status, proposed_sandbox_status,
       sandbox_eligible, recommended_profile, run_complete,
       bundle_evidence_present, failing_bundle_count,
       incomplete_bundle_count, sandbox_unresolved_bundle_count,
       unattributed_failure_count,
       selected_storyboard_count, applicable_phase_count,
       controller_gap_phase_count, controller_gap_step_count,
       controller_cascade_step_count, observed_failure_count,
       sandbox_observable_failure_count, non_controller_gap_step_count,
       controller_missing_storyboard_count, other_missing_storyboard_count,
       mixed_controller_failure_phase_count,
       flat_failure_count, unattributed_flat_failure_count,
       unexplained_phase_failure_count,
       sandbox_unresolved_executed_bundle_count,
       sandbox_unresolved_missing_tools_bundle_count,
       sandbox_unresolved_unknown_bundle_count,
       evaluated_at, source_tested_at, requested_compliance_target
     ) SELECT
       $1, $2, $3, $4, $5,
       $6, $7, $8,
       $9, $10, $11,
       $12, $13,
       $14, $15,
       $16, $17,
       $18, $19,
       $20, $21,
       $22, $23,
       $24, $25,
       $26, $27,
       $28, $29, $30,
       $31, $32, $33,
       NOW(), source_run.tested_at, source_run.requested_compliance_target
     FROM collection_enabled CROSS JOIN source_run
     ON CONFLICT (source_run_id) DO NOTHING
     RETURNING source_run_id`,
    [
      input.sourceRunId,
      input.agentUrl,
      input.lifecycleStage,
      input.adcpVersion ?? null,
      assessment.policy_version,
      assessment.current_public_status,
      assessment.proposed_spec_status,
      assessment.proposed_sandbox_status,
      assessment.sandbox_eligible,
      assessment.recommended_profile,
      assessment.run_complete,
      assessment.bundle_evidence_present,
      assessment.failing_bundle_count,
      assessment.incomplete_bundle_count,
      assessment.sandbox_unresolved_bundle_count,
      assessment.unattributed_failure_count,
      assessment.selected_storyboard_count,
      assessment.applicable_phase_count,
      assessment.controller_gap_phase_count,
      assessment.controller_gap_step_count,
      assessment.controller_cascade_step_count,
      assessment.observed_failure_count,
      assessment.sandbox_observable_failure_count,
      assessment.non_controller_gap_step_count,
      assessment.controller_missing_storyboard_count,
      assessment.other_missing_storyboard_count,
      assessment.mixed_controller_failure_phase_count,
      assessment.flat_failure_count,
      assessment.unattributed_flat_failure_count,
      assessment.unexplained_phase_failure_count,
      assessment.sandbox_unresolved_executed_bundle_count,
      assessment.sandbox_unresolved_missing_tools_bundle_count,
      assessment.sandbox_unresolved_unknown_bundle_count,
      SETTING_KEYS.VERIFICATION_PROFILE_SHADOW_ROLLOUT,
    ],
  ), { readOnly: false });
  return result.rowCount === 1;
}

/**
 * Return the newest agent-wide comparison. Assessments remain read-only
 * evidence: callers may display them, but they do not drive badges.
 */
export async function getLatestVerificationProfileAssessment(
  agentUrl: string,
  policyVersion: string,
): Promise<StoredVerificationProfileAssessment | null> {
  const result = await withDatabaseDeadline(Date.now() + 2_000, () => query<StoredVerificationProfileAssessment>(
    `SELECT s.*, r.provenance_json AS source_provenance
     FROM verification_profile_shadow_assessments s
     JOIN agent_compliance_runs r
      ON r.id = s.source_run_id
      AND r.agent_url = s.agent_url
      AND r.lifecycle_stage = s.lifecycle_stage
      AND r.adcp_version IS NOT DISTINCT FROM s.adcp_version
     WHERE s.agent_url = $1
       AND s.policy_version = $2
       AND s.adcp_version IS NOT NULL
       AND s.source_tested_at IS NOT NULL
       AND r.dry_run = FALSE
       AND r.is_authoritative = TRUE
       AND r.completeness = 'complete'
     ORDER BY s.evaluated_at DESC
     LIMIT 1`,
    [agentUrl, policyVersion],
  ), { readOnly: true });
  return result.rows[0] ?? null;
}

/**
 * Delete rows beyond the fixed 90-day retention window.
 */
export async function pruneVerificationProfileShadowAssessments(): Promise<number> {
  const result = await withDatabaseDeadline(Date.now() + 2_000, () => query<{ pruned_count: string | number }>(
    `SELECT prune_verification_profile_shadow_assessments() AS pruned_count`,
  ), { readOnly: false });
  return Number(result.rows[0]?.pruned_count ?? 0);
}
