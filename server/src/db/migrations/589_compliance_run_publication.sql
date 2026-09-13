-- Scheduling must not change the last authoritative card timestamp.
ALTER TABLE agent_registry_metadata ADD COLUMN next_compliance_check_at TIMESTAMPTZ;
UPDATE agent_registry_metadata m
SET next_compliance_check_at = s.last_checked_at + make_interval(hours => m.check_interval_hours)
FROM agent_compliance_status s
WHERE s.agent_url = m.agent_url AND s.last_checked_at IS NOT NULL;

-- Incomplete suites remain immutable audit evidence and never replace public grades.
ALTER TABLE agent_compliance_runs
  ADD COLUMN completeness TEXT NOT NULL DEFAULT 'complete' CHECK (completeness IN ('complete', 'timed_out', 'not_completed')),
  ADD COLUMN is_authoritative BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN storyboard_statuses_json JSONB;
ALTER TABLE agent_compliance_runs ADD CONSTRAINT compliance_complete_before_publication
  CHECK (NOT is_authoritative OR completeness = 'complete');
CREATE INDEX agent_compliance_runs_authoritative_latest
  ON agent_compliance_runs (agent_url, tested_at DESC)
  WHERE dry_run = FALSE AND is_authoritative = TRUE;

CREATE OR REPLACE VIEW agent_context_with_latest_test AS
SELECT
  ac.*,
  COALESCE(latest.tested_at, ac.last_tested_at) AS canonical_last_tested_at,
  COALESCE(latest.overall_status = 'passing', ac.last_test_passed) AS canonical_last_test_passed,
  CASE
    WHEN latest.tested_at IS NULL THEN ac.last_test_scenario
    ELSE COALESCE(latest.tracks_json -> 0 ->> 'track', 'compliance')
  END AS canonical_last_test_scenario,
  COALESCE(latest.headline, ac.last_test_summary) AS canonical_last_test_summary,
  CASE
    WHEN latest.tested_at IS NULL THEN ac.total_tests_run
    ELSE COALESCE(run_counts.total, 0)
  END AS canonical_total_tests_run
FROM agent_contexts ac
LEFT JOIN LATERAL (
  SELECT tested_at, overall_status, tracks_json, headline
  FROM agent_compliance_runs acr
  WHERE acr.triggered_org_id = ac.organization_id
    AND acr.agent_url = ac.agent_url
    AND acr.dry_run = FALSE
    AND acr.is_authoritative = TRUE
  ORDER BY tested_at DESC
  LIMIT 1
) AS latest ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS total
  FROM agent_compliance_runs acr
  WHERE acr.triggered_org_id = ac.organization_id
    AND acr.agent_url = ac.agent_url
    AND acr.dry_run = FALSE
    AND acr.is_authoritative = TRUE
) AS run_counts ON TRUE;

COMMENT ON VIEW agent_context_with_latest_test IS
  'Derives last_test_* fields from agent_compliance_runs (triggered_org_id-scoped), falling back to legacy agent_contexts.last_test_* fields for non-owner tests until recordTest() retires (#4247 PR-after-drop).';
