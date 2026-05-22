-- Migration 490: add triggered_org_id to agent_compliance_runs and create
-- agent_context_with_latest_test view.
--
-- Part of the #4247 compliance-state unification (PR 4 of 4). Today,
-- agent_contexts.last_test_* columns carry the most-recent test verdict
-- per (organization_id, agent_url). After PR #4250 owner runs write
-- canonical state via agent_compliance_runs, but that table tracks only
-- agent_url — there's no org dimension, so a derived "latest owner test"
-- can't be accurately scoped per org. Two orgs that own the same agent
-- (rare but possible — staging vs prod org of one publisher, for example)
-- would conflate.
--
-- Adding triggered_org_id closes the gap. Populated by the owner-test
-- write path in evaluate_agent_quality (this PR). Heartbeat / manual /
-- webhook writes leave it NULL.

ALTER TABLE agent_compliance_runs
  ADD COLUMN IF NOT EXISTS triggered_org_id TEXT;

COMMENT ON COLUMN agent_compliance_runs.triggered_org_id IS
  'WorkOS organization ID of the org that triggered the run. Stored as TEXT (no FK) because WorkOS IDs are foreign-system keys — referential integrity against organizations.workos_organization_id is not enforced at the DB layer. Populated only for triggered_by=''owner_test''; heartbeat / manual / webhook rows leave it NULL.';

-- Index supports the derived `agent_context_with_latest_test` view's
-- per-(org, url) LATERAL lookup. tested_at DESC keeps the latest-row
-- pull as a single index scan.
CREATE INDEX IF NOT EXISTS idx_agent_compliance_runs_triggered_org_url_at
  ON agent_compliance_runs (triggered_org_id, agent_url, tested_at DESC)
  WHERE triggered_org_id IS NOT NULL;

-- Rows backfilled before this column existed stored their org dimension in
-- observations_json. Copy it into triggered_org_id so transition-window owner
-- runs are visible to the derived view. Rows that remain dry_run=TRUE are still
-- ignored by the view, preserving dry-run semantics.
UPDATE agent_compliance_runs
SET triggered_org_id = observations_json ->> 'backfill_org_id'
WHERE triggered_by = 'owner_test'
  AND triggered_org_id IS NULL
  AND observations_json ? 'backfill_org_id';

-- View: agent_context joined with the latest agent_compliance_runs row
-- scoped to that org via triggered_org_id. Falls back to the legacy
-- agent_contexts.last_test_* columns when no owner-canonical row exists.
--
-- The columns on agent_contexts stay for backward compat — recordTest()
-- still writes them for third-party (non-owner) runs, and a follow-up
-- migration drops them once recordTest() retires (gated on the
-- agent_test_history drop, which is itself gated on the soak windows
-- documented in #4247).
--
-- last_test_passed: derived from overall_status='passing' when a canonical
--   owner row exists, else falls back to agent_contexts.last_test_passed.
-- last_test_scenario: tracks_json[0].track when present, else 'compliance'
--   (heartbeat/manual writes don't carry the legacy 'quality_evaluation'
--   scenario string — the closest semantic in the canonical schema is the
--   first track of the run). Falls back to agent_contexts.last_test_scenario
--   when there is no canonical owner row.
-- last_test_summary: agent_compliance_runs.headline, falling back to
--   agent_contexts.last_test_summary.
-- last_tested_at: agent_compliance_runs.tested_at, falling back to
--   agent_contexts.last_tested_at.
-- total_tests_run: COUNT(*) of agent_compliance_runs rows scoped to the
--   org+url when a canonical owner row exists, else falls back to the legacy
--   per-context counter.
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
  ORDER BY tested_at DESC
  LIMIT 1
) AS latest ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS total
  FROM agent_compliance_runs acr
  WHERE acr.triggered_org_id = ac.organization_id
    AND acr.agent_url = ac.agent_url
    AND acr.dry_run = FALSE
) AS run_counts ON TRUE;

COMMENT ON VIEW agent_context_with_latest_test IS
  'Derives last_test_* fields from agent_compliance_runs (triggered_org_id-scoped), falling back to legacy agent_contexts.last_test_* fields for non-owner tests until recordTest() retires (#4247 PR-after-drop).';
