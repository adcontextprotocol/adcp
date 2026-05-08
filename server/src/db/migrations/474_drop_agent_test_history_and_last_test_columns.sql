-- Migration 474: drop agent_test_history table + agent_contexts.last_test_*
-- columns. Final cleanup of the #4247 compliance-state unification stack.
--
-- Pre-merge gate (load-bearing — DO NOT RUN until each is satisfied):
--
-- 1. PR #4250 has been live in prod for ≥ 14 days with zero canonical-write
--    incidents (no malformed agent_compliance_status row, no flap reports).
-- 2. PR #4263 has been live in prod for ≥ 7 days with the dashboard
--    rendering identical verdicts via the view-derived path.
-- 3. PR #4264's migration 472 has run and the row-count delta on staging
--    is ±0 (every owner-triggered agent_test_history row backfilled into
--    agent_compliance_runs).
-- 4. Third-party (`user_id IS NULL`) rows from agent_test_history have
--    been exported to S3 cold storage. Export evidence committed to the
--    ops runbook before this migration runs. Do NOT silently lose audit
--    history.
-- 5. PR #4268's view + reader migration confirmed working in prod
--    (all callers of last_test_* read from agent_context_with_latest_test
--    via the column-aliased SELECTs).
--
-- This migration is destructive and irreversible. Reversibility path is
-- the S3 export from gate (4), not pg_dump.

-- ── Phase 1: drop the dependent view, redefining without legacy columns ──

DROP VIEW IF EXISTS agent_context_summary;

CREATE OR REPLACE VIEW agent_context_summary AS
SELECT
  ac.id,
  ac.organization_id,
  ac.agent_url,
  ac.agent_name,
  ac.agent_type,
  ac.protocol,
  ac.auth_token_hint,
  ac.auth_token_encrypted IS NOT NULL as has_auth_token,
  ac.oauth_access_token_encrypted IS NOT NULL as has_oauth_token,
  ac.oauth_token_expires_at,
  ac.oauth_client_id IS NOT NULL as has_oauth_client,
  ac.tools_discovered,
  -- last_test_* fields now derived from agent_compliance_runs scoped to
  -- (triggered_org_id, agent_url) rather than read off the legacy
  -- agent_contexts columns. Mirrors agent_context_with_latest_test
  -- (migration 473) so callers can stop using the legacy view if they
  -- prefer the explicit canonical-source name.
  v.canonical_last_test_scenario AS last_test_scenario,
  v.canonical_last_test_passed AS last_test_passed,
  v.canonical_last_test_summary AS last_test_summary,
  v.canonical_last_tested_at AS last_tested_at,
  v.canonical_total_tests_run AS total_tests_run,
  ac.created_at,
  ac.updated_at,
  -- history_count / history_passed_count from agent_test_history removed —
  -- the canonical-runs derivation gives total_tests_run, and a history
  -- count of "passing runs" is inferable from the per-org rollup of
  -- agent_compliance_runs if needed.
  v.canonical_total_tests_run AS history_count,
  COALESCE((
    SELECT COUNT(*)
    FROM agent_compliance_runs acr
    WHERE acr.triggered_org_id = ac.organization_id
      AND acr.agent_url = ac.agent_url
      AND acr.dry_run = FALSE
      AND acr.overall_status = 'passing'
  ), 0) AS history_passed_count
FROM agent_contexts ac
LEFT JOIN agent_context_with_latest_test v ON v.id = ac.id;

COMMENT ON VIEW agent_context_summary IS
  'Agent contexts with auth info and last_test_* derived from agent_compliance_runs (canonical). Replaces the migration 195 definition that referenced the dropped agent_test_history.';

-- ── Phase 2: drop legacy columns from agent_contexts ──

-- agent_context_with_latest_test (migration 473) selects ac.* — once these
-- columns drop, ac.* simply omits them. The view's aliased
-- canonical_last_test_* fields stay intact (they come from the LATERAL
-- JOIN against agent_compliance_runs).

ALTER TABLE agent_contexts DROP COLUMN IF EXISTS last_test_scenario;
ALTER TABLE agent_contexts DROP COLUMN IF EXISTS last_test_passed;
ALTER TABLE agent_contexts DROP COLUMN IF EXISTS last_test_summary;
ALTER TABLE agent_contexts DROP COLUMN IF EXISTS last_tested_at;
ALTER TABLE agent_contexts DROP COLUMN IF EXISTS total_tests_run;

-- ── Phase 3: drop agent_test_history ──

-- Indexes drop with the table.
-- ON DELETE CASCADE FK from agent_contexts.id is severed when the table
-- drops; agent_contexts is unaffected.

DROP TABLE IF EXISTS agent_test_history;

-- ── Phase 4: refresh agent_context_with_latest_test ──
-- The view (from migration 473) selects ac.* — once last_test_* columns
-- are gone, the view's projection no longer includes them. CREATE OR
-- REPLACE re-binds the view definition cleanly.

CREATE OR REPLACE VIEW agent_context_with_latest_test AS
SELECT
  ac.*,
  latest.tested_at AS canonical_last_tested_at,
  latest.overall_status = 'passing' AS canonical_last_test_passed,
  COALESCE(
    (latest.tracks_json -> 0 ->> 'track'),
    'compliance'
  ) AS canonical_last_test_scenario,
  latest.headline AS canonical_last_test_summary,
  COALESCE(run_counts.total, 0) AS canonical_total_tests_run
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
