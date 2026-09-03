-- Additive, observation-only diagnostics for the v3 verification-profile
-- evidence stream. These columns explain fail-closed gates; they never drive
-- public compliance, badges, notifications, or agent requests.

ALTER TABLE verification_profile_shadow_assessments
  ADD COLUMN IF NOT EXISTS unattributed_flat_failure_count INTEGER NOT NULL DEFAULT 0
    CHECK (unattributed_flat_failure_count >= 0),
  ADD COLUMN IF NOT EXISTS unexplained_phase_failure_count INTEGER NOT NULL DEFAULT 0
    CHECK (unexplained_phase_failure_count >= 0),
  ADD COLUMN IF NOT EXISTS sandbox_unresolved_executed_bundle_count INTEGER NOT NULL DEFAULT 0
    CHECK (sandbox_unresolved_executed_bundle_count >= 0),
  ADD COLUMN IF NOT EXISTS sandbox_unresolved_missing_tools_bundle_count INTEGER NOT NULL DEFAULT 0
    CHECK (sandbox_unresolved_missing_tools_bundle_count >= 0),
  ADD COLUMN IF NOT EXISTS sandbox_unresolved_unknown_bundle_count INTEGER NOT NULL DEFAULT 0
    CHECK (sandbox_unresolved_unknown_bundle_count >= 0);

ALTER TABLE verification_profile_shadow_assessments
  ADD CONSTRAINT verification_profile_shadow_v3_attribution_totals CHECK (
    policy_version <> 'verification-profiles-v3' OR
    unattributed_failure_count =
      unattributed_flat_failure_count + unexplained_phase_failure_count
  ),
  ADD CONSTRAINT verification_profile_shadow_v3_bundle_totals CHECK (
    policy_version <> 'verification-profiles-v3' OR
    sandbox_unresolved_bundle_count =
      sandbox_unresolved_executed_bundle_count +
      sandbox_unresolved_missing_tools_bundle_count +
      sandbox_unresolved_unknown_bundle_count
  );

COMMENT ON COLUMN verification_profile_shadow_assessments.unattributed_flat_failure_count IS
  'Flat SDK failure entries missing storyboard or step identity; fail-closed diagnostic only';
COMMENT ON COLUMN verification_profile_shadow_assessments.unexplained_phase_failure_count IS
  'Failed phases with neither a failed step nor a controller-gap explanation; fail-closed diagnostic only';
COMMENT ON COLUMN verification_profile_shadow_assessments.sandbox_unresolved_executed_bundle_count IS
  'Unresolved partial/untested Sandbox bundles containing at least one executed storyboard';
COMMENT ON COLUMN verification_profile_shadow_assessments.sandbox_unresolved_missing_tools_bundle_count IS
  'Unresolved partial/untested Sandbox bundles containing missing-tool storyboard evidence and no executed storyboard';
COMMENT ON COLUMN verification_profile_shadow_assessments.sandbox_unresolved_unknown_bundle_count IS
  'Unresolved partial/untested Sandbox bundles without executed or missing-tool storyboard evidence';
