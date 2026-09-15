-- Phase 1 of owner-selectable grading profiles: keep comparison collection on
-- until an administrator deliberately disables it. This is observation-only;
-- it reuses completed heartbeat evidence and cannot change public trust state.

-- Snapshot the source fields needed to explain a comparison. Existing shadow
-- rows are backfilled from their source run before collection becomes durable;
-- new rows populate these columns in the same INSERT as the assessment.
ALTER TABLE verification_profile_shadow_assessments
  ADD COLUMN IF NOT EXISTS source_tested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requested_compliance_target TEXT,
  ADD COLUMN IF NOT EXISTS flat_failure_count INTEGER NOT NULL DEFAULT 0
    CHECK (flat_failure_count >= 0);

-- Older v3 rows only distinguished malformed flat failures. Preserve that
-- known lower bound; new writes store the complete flat-failure count.
UPDATE verification_profile_shadow_assessments
SET flat_failure_count = unattributed_flat_failure_count
WHERE flat_failure_count < unattributed_flat_failure_count;

UPDATE verification_profile_shadow_assessments assessment
SET source_tested_at = source.tested_at,
    requested_compliance_target = source.requested_compliance_target
FROM agent_compliance_runs source
WHERE source.id = assessment.source_run_id
  AND assessment.source_tested_at IS NULL;

ALTER TABLE verification_profile_shadow_assessments
  ALTER COLUMN source_tested_at SET NOT NULL;

COMMENT ON COLUMN verification_profile_shadow_assessments.source_tested_at IS
  'Immutable snapshot of the source compliance run tested_at timestamp';
COMMENT ON COLUMN verification_profile_shadow_assessments.requested_compliance_target IS
  'Immutable snapshot of the compliance target used by the source run';
COMMENT ON COLUMN verification_profile_shadow_assessments.flat_failure_count IS
  'Total SDK run-level failures, including entries with storyboard and step identity';

WITH previous AS MATERIALIZED (
  SELECT value
  FROM system_settings
  WHERE key = 'verification_profile_shadow_rollout'
  FOR UPDATE
), updated AS (
  UPDATE system_settings
  SET value = '{"enabled": true, "expires_at": null}'::jsonb,
      description = 'Collect read-only Legacy, Spec, and Sandbox comparisons from completed compliance heartbeats',
      updated_at = NOW(),
      updated_by = 'migration:591_enable_verification_profile_comparisons'
  WHERE key = 'verification_profile_shadow_rollout'
  RETURNING value
)
INSERT INTO system_settings_audit (key, old_value, new_value, changed_by, changed_at)
SELECT
  'verification_profile_shadow_rollout',
  previous.value,
  updated.value,
  'migration:591_enable_verification_profile_comparisons',
  NOW()
FROM previous CROSS JOIN updated;
