-- Observation-only ledger for the verification-profile rollout. The heartbeat
-- reuses completed compliance results; this table never drives public status,
-- badges, notifications, or agent requests.

CREATE TABLE IF NOT EXISTS verification_profile_shadow_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_run_id UUID NOT NULL UNIQUE
    REFERENCES agent_compliance_runs(id) ON DELETE CASCADE,
  agent_url TEXT NOT NULL,
  lifecycle_stage TEXT NOT NULL CHECK (
    lifecycle_stage IN ('development', 'testing', 'production', 'deprecated')
  ),
  adcp_version TEXT,
  policy_version VARCHAR(64) NOT NULL CHECK (
    length(btrim(policy_version)) BETWEEN 1 AND 64
  ),
  current_public_status TEXT NOT NULL CHECK (
    current_public_status IN ('passing', 'partial', 'failing')
  ),
  proposed_spec_status TEXT NOT NULL CHECK (
    proposed_spec_status IN ('passing', 'partial', 'failing')
  ),
  proposed_sandbox_status TEXT CHECK (
    proposed_sandbox_status IS NULL OR
    proposed_sandbox_status IN ('passing', 'partial', 'failing')
  ),
  sandbox_eligible BOOLEAN NOT NULL,
  recommended_profile TEXT CHECK (
    recommended_profile IS NULL OR recommended_profile IN ('spec', 'sandbox')
  ),
  run_complete BOOLEAN NOT NULL,
  bundle_evidence_present BOOLEAN NOT NULL,
  failing_bundle_count INTEGER NOT NULL CHECK (failing_bundle_count >= 0),
  incomplete_bundle_count INTEGER NOT NULL CHECK (incomplete_bundle_count >= 0),
  sandbox_unresolved_bundle_count INTEGER NOT NULL CHECK (sandbox_unresolved_bundle_count >= 0),
  unattributed_failure_count INTEGER NOT NULL CHECK (unattributed_failure_count >= 0),
  selected_storyboard_count INTEGER NOT NULL CHECK (selected_storyboard_count >= 0),
  applicable_phase_count INTEGER NOT NULL CHECK (applicable_phase_count >= 0),
  controller_gap_phase_count INTEGER NOT NULL CHECK (controller_gap_phase_count >= 0),
  controller_gap_step_count INTEGER NOT NULL CHECK (controller_gap_step_count >= 0),
  controller_cascade_step_count INTEGER NOT NULL CHECK (controller_cascade_step_count >= 0),
  observed_failure_count INTEGER NOT NULL CHECK (observed_failure_count >= 0),
  sandbox_observable_failure_count INTEGER NOT NULL CHECK (sandbox_observable_failure_count >= 0),
  non_controller_gap_step_count INTEGER NOT NULL CHECK (non_controller_gap_step_count >= 0),
  controller_missing_storyboard_count INTEGER NOT NULL CHECK (controller_missing_storyboard_count >= 0),
  other_missing_storyboard_count INTEGER NOT NULL CHECK (other_missing_storyboard_count >= 0),
  mixed_controller_failure_phase_count INTEGER NOT NULL CHECK (mixed_controller_failure_phase_count >= 0),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sandbox_eligible = (lifecycle_stage = 'production')),
  CHECK ((sandbox_eligible AND proposed_sandbox_status IS NOT NULL) OR
         (NOT sandbox_eligible AND proposed_sandbox_status IS NULL)),
  CHECK (
    (lifecycle_stage = 'testing' AND recommended_profile = 'spec') OR
    (lifecycle_stage = 'production' AND recommended_profile IN ('spec', 'sandbox')) OR
    (lifecycle_stage IN ('development', 'deprecated') AND recommended_profile IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_verification_profile_shadow_evaluated
  ON verification_profile_shadow_assessments(evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_profile_shadow_agent
  ON verification_profile_shadow_assessments(agent_url, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_profile_shadow_impact
  ON verification_profile_shadow_assessments(
    policy_version, current_public_status, proposed_spec_status, proposed_sandbox_status
  );

COMMENT ON TABLE verification_profile_shadow_assessments IS
  'Observation-only candidate verification-profile outcomes scheduled for deletion after 90 days; never authoritative for public trust state';

-- This explicit pruning seam is safe for a scheduler or an operator to call
-- even while collection is disabled. It returns the number of expired rows.
CREATE OR REPLACE FUNCTION prune_verification_profile_shadow_assessments()
RETURNS BIGINT
LANGUAGE SQL
AS $$
  WITH deleted AS (
    DELETE FROM verification_profile_shadow_assessments
    WHERE evaluated_at < NOW() - INTERVAL '90 days'
    RETURNING 1
  )
  SELECT COUNT(*)::BIGINT FROM deleted
$$;

COMMENT ON FUNCTION prune_verification_profile_shadow_assessments() IS
  'Deletes verification-profile shadow assessments older than the 90-day retention window';

INSERT INTO system_settings (key, value, description)
VALUES (
  'verification_profile_shadow_rollout',
  '{"enabled": false, "expires_at": null}'::jsonb,
  'Collect observation-only Spec and Sandbox candidate outcomes for an audited lease of at most 72 hours'
)
ON CONFLICT (key) DO NOTHING;
