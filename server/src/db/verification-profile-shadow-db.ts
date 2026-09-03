import { query, withDatabaseDeadline } from './client.js';
import type { LifecycleStage } from './compliance-db.js';
import type { VerificationProfileShadowAssessment } from '../services/verification-profile-shadow.js';
import { SETTING_KEYS } from './system-settings-db.js';

export async function recordVerificationProfileShadowAssessment(input: {
  sourceRunId: string;
  agentUrl: string;
  lifecycleStage: LifecycleStage;
  adcpVersion?: string | null;
  assessment: VerificationProfileShadowAssessment;
}): Promise<boolean> {
  const { assessment } = input;
  const result = await withDatabaseDeadline(Date.now() + 2_000, () => query(
    `WITH rollout AS MATERIALIZED (
       SELECT 1
       FROM system_settings
       WHERE key = $33
         AND value->>'enabled' = 'true'
         AND COALESCE(value->>'expires_at', '') ~
           '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{3})?Z$'
         AND (value->>'expires_at')::timestamptz > NOW()
       FOR SHARE
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
       unattributed_flat_failure_count, unexplained_phase_failure_count,
       sandbox_unresolved_executed_bundle_count,
       sandbox_unresolved_missing_tools_bundle_count,
       sandbox_unresolved_unknown_bundle_count,
       evaluated_at
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
       $28, $29,
       $30, $31, $32,
       NOW()
     FROM rollout
     ON CONFLICT (source_run_id) DO UPDATE SET
       lifecycle_stage = EXCLUDED.lifecycle_stage,
       adcp_version = EXCLUDED.adcp_version,
       policy_version = EXCLUDED.policy_version,
       current_public_status = EXCLUDED.current_public_status,
       proposed_spec_status = EXCLUDED.proposed_spec_status,
       proposed_sandbox_status = EXCLUDED.proposed_sandbox_status,
       sandbox_eligible = EXCLUDED.sandbox_eligible,
       recommended_profile = EXCLUDED.recommended_profile,
       run_complete = EXCLUDED.run_complete,
       bundle_evidence_present = EXCLUDED.bundle_evidence_present,
       failing_bundle_count = EXCLUDED.failing_bundle_count,
       incomplete_bundle_count = EXCLUDED.incomplete_bundle_count,
       sandbox_unresolved_bundle_count = EXCLUDED.sandbox_unresolved_bundle_count,
       unattributed_failure_count = EXCLUDED.unattributed_failure_count,
       selected_storyboard_count = EXCLUDED.selected_storyboard_count,
       applicable_phase_count = EXCLUDED.applicable_phase_count,
       controller_gap_phase_count = EXCLUDED.controller_gap_phase_count,
       controller_gap_step_count = EXCLUDED.controller_gap_step_count,
       controller_cascade_step_count = EXCLUDED.controller_cascade_step_count,
       observed_failure_count = EXCLUDED.observed_failure_count,
       sandbox_observable_failure_count = EXCLUDED.sandbox_observable_failure_count,
       non_controller_gap_step_count = EXCLUDED.non_controller_gap_step_count,
       controller_missing_storyboard_count = EXCLUDED.controller_missing_storyboard_count,
       other_missing_storyboard_count = EXCLUDED.other_missing_storyboard_count,
       mixed_controller_failure_phase_count = EXCLUDED.mixed_controller_failure_phase_count,
       unattributed_flat_failure_count = EXCLUDED.unattributed_flat_failure_count,
       unexplained_phase_failure_count = EXCLUDED.unexplained_phase_failure_count,
       sandbox_unresolved_executed_bundle_count = EXCLUDED.sandbox_unresolved_executed_bundle_count,
       sandbox_unresolved_missing_tools_bundle_count = EXCLUDED.sandbox_unresolved_missing_tools_bundle_count,
       sandbox_unresolved_unknown_bundle_count = EXCLUDED.sandbox_unresolved_unknown_bundle_count,
       evaluated_at = NOW()
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
 * Delete rows beyond the fixed 90-day retention window. This remains callable
 * while collection is disabled, so expiry does not depend on new heartbeats.
 */
export async function pruneVerificationProfileShadowAssessments(): Promise<number> {
  const result = await withDatabaseDeadline(Date.now() + 2_000, () => query<{ pruned_count: string | number }>(
    `SELECT prune_verification_profile_shadow_assessments() AS pruned_count`,
  ), { readOnly: false });
  return Number(result.rows[0]?.pruned_count ?? 0);
}
