-- Migration 493: add notices_json to agent_compliance_runs.
--
-- Surfaces runner-emitted advisory notices from run-summary level through to
-- the DB, API, and dashboard. Notices are informational signals (info,
-- deprecation, future_required) that MUST NOT affect pass/fail counters.
-- Defined in static/compliance/source/universal/runner-output-contract.yaml.
--
-- Forward-compat: unknown notice codes and severities are stored verbatim.

ALTER TABLE agent_compliance_runs
  ADD COLUMN IF NOT EXISTS notices_json JSONB;

COMMENT ON COLUMN agent_compliance_runs.notices_json IS
  'Advisory notices emitted by the compliance runner at run-summary level (runner-output-contract.yaml §run_summary.notices). Each element has {severity, code, message} required and {effective_version, capability_path, reference_url} optional. Stored verbatim — unknown codes/severities MUST be preserved. NULL when the runner emitted no notices.';
