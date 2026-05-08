-- Migration 476: backfill owner-triggered agent_test_history rows into
-- agent_compliance_runs as triggered_by='owner_test' rows.
--
-- Part of the #4247 compliance-state unification. PR #4250 (merged) made
-- evaluate_agent_quality write canonical for owner runs going forward;
-- this migration backfills the historical rows so the compliance API
-- and dashboard reflect the full test history, not just runs from the
-- PR #4250 deploy onward.
--
-- Scope: backfill ONLY rows with user_id IS NOT NULL (real owner-triggered
-- tests). Third-party / scheduled / unattributed rows are NOT touched here
-- — the table drop is a separate follow-up that includes an S3 cold-storage
-- export of those rows so audit history isn't silently lost (see #4247
-- Acceptance Criteria).
--
-- Mapping:
--   agent_test_history.agent_context_id → agent_contexts.agent_url
--   agent_test_history.overall_passed   → overall_status ('passing' | 'failing')
--   agent_test_history.steps_passed     → tracks_passed
--   agent_test_history.steps_failed     → tracks_failed
--   agent_test_history.total_duration_ms→ total_duration_ms
--   agent_test_history.summary          → headline
--   agent_test_history.agent_profile_json → agent_profile_json
--   agent_test_history.started_at       → tested_at
--   triggered_by                        → 'owner_test' (constant)
--   dry_run                             → false (PR #4250's owner path uses dry_run=false)
--
-- Idempotency: backfilled rows carry the source agent_test_history.id in
-- observations_json.{backfill_source} so a re-run is a no-op via the
-- WHERE NOT EXISTS guard.

INSERT INTO agent_compliance_runs (
  agent_url,
  lifecycle_stage,
  overall_status,
  headline,
  total_duration_ms,
  tracks_json,
  tracks_passed,
  tracks_failed,
  tracks_skipped,
  tracks_partial,
  agent_profile_json,
  observations_json,
  triggered_by,
  dry_run,
  tested_at
)
SELECT
  ac.agent_url,
  COALESCE(arm.lifecycle_stage, 'production') AS lifecycle_stage,
  CASE WHEN ath.overall_passed THEN 'passing' ELSE 'failing' END AS overall_status,
  ath.summary AS headline,
  ath.total_duration_ms,
  '[]'::jsonb AS tracks_json,
  COALESCE(ath.steps_passed, 0) AS tracks_passed,
  COALESCE(ath.steps_failed, 0) AS tracks_failed,
  0 AS tracks_skipped,
  0 AS tracks_partial,
  ath.agent_profile_json,
  jsonb_build_object(
    'backfill_source', 'agent_test_history',
    'backfill_source_id', ath.id::text,
    'backfill_migration', '472',
    'original_scenario', ath.scenario
  ) AS observations_json,
  'owner_test' AS triggered_by,
  FALSE AS dry_run,
  ath.started_at AS tested_at
FROM agent_test_history ath
JOIN agent_contexts ac ON ac.id = ath.agent_context_id
LEFT JOIN agent_registry_metadata arm ON arm.agent_url = ac.agent_url
WHERE ath.user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM agent_compliance_runs acr
    WHERE acr.observations_json->>'backfill_source_id' = ath.id::text
  );

-- Update agent_compliance_status from the latest backfilled row per agent
-- so the dashboard immediately reflects the most recent owner-triggered
-- verdict for any agent that didn't yet have a heartbeat row. Skipped
-- when a status row already exists from a more recent heartbeat — heartbeat
-- always wins on freshness, last-write-wins is the contract pinned in
-- PR #4250's tests.
INSERT INTO agent_compliance_status (
  agent_url,
  status,
  lifecycle_stage,
  last_checked_at,
  last_passed_at,
  last_failed_at,
  tracks_summary_json,
  headline,
  status_changed_at,
  last_triggered_by
)
SELECT DISTINCT ON (acr.agent_url)
  acr.agent_url,
  CASE WHEN acr.overall_status = 'passing' THEN 'passing' ELSE 'failing' END,
  acr.lifecycle_stage,
  acr.tested_at,
  CASE WHEN acr.overall_status = 'passing' THEN acr.tested_at ELSE NULL END,
  CASE WHEN acr.overall_status = 'failing' THEN acr.tested_at ELSE NULL END,
  '{}'::jsonb,
  acr.headline,
  acr.tested_at,
  'owner_test'
FROM agent_compliance_runs acr
WHERE acr.observations_json->>'backfill_migration' = '472'
ORDER BY acr.agent_url, acr.tested_at DESC
ON CONFLICT (agent_url) DO UPDATE SET
  status = CASE
    WHEN agent_compliance_status.last_checked_at IS NULL
      OR agent_compliance_status.last_checked_at < EXCLUDED.last_checked_at
    THEN EXCLUDED.status
    ELSE agent_compliance_status.status
  END,
  last_checked_at = GREATEST(
    COALESCE(agent_compliance_status.last_checked_at, EXCLUDED.last_checked_at),
    EXCLUDED.last_checked_at
  ),
  last_passed_at = CASE
    WHEN EXCLUDED.last_passed_at IS NOT NULL
      AND (agent_compliance_status.last_passed_at IS NULL
        OR agent_compliance_status.last_passed_at < EXCLUDED.last_passed_at)
    THEN EXCLUDED.last_passed_at
    ELSE agent_compliance_status.last_passed_at
  END,
  last_failed_at = CASE
    WHEN EXCLUDED.last_failed_at IS NOT NULL
      AND (agent_compliance_status.last_failed_at IS NULL
        OR agent_compliance_status.last_failed_at < EXCLUDED.last_failed_at)
    THEN EXCLUDED.last_failed_at
    ELSE agent_compliance_status.last_failed_at
  END,
  last_triggered_by = CASE
    WHEN agent_compliance_status.last_checked_at IS NULL
      OR agent_compliance_status.last_checked_at < EXCLUDED.last_checked_at
    THEN EXCLUDED.last_triggered_by
    ELSE agent_compliance_status.last_triggered_by
  END;

-- NOTE: this migration does NOT drop agent_test_history. The drop is
-- deferred to a follow-up migration that runs after:
--   (a) the 14-day soak window from PR #4250 deploy,
--   (b) the 7-day soak window from PR #4263 deploy,
--   (c) S3 cold-storage export of third-party rows (user_id IS NULL),
--   (d) row-count delta verification on staging.
-- See #4247 acceptance criteria.
