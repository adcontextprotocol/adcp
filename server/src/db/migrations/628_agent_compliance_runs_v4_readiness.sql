-- Migration 628: add v4_readiness_json to agent_compliance_runs (adcp#8332).
--
-- Advisory AdCP 4.0 readiness report computed at ingest from the runner
-- result, graded against universal/v4-compatibility.yaml. Passed validations
-- are not persisted anywhere else, so the report cannot be reconstructed
-- later from failed_validations_jsonb or notices_json.
--
-- The report never affects 3.x verification or conformance. Nothing
-- backfills: runs ingested before this migration keep NULL, and readers show
-- no report for them.

ALTER TABLE agent_compliance_runs
  ADD COLUMN IF NOT EXISTS v4_readiness_json JSONB;

COMMENT ON COLUMN agent_compliance_runs.v4_readiness_json IS
  'Advisory AdCP 4.0 readiness report: {registry_version, target_version, checks: [{id, status (passed|failing|not_observable), reason, issue, change, detection, fix, guide_url}]}. Check ids and text come from universal/v4-compatibility.yaml. NULL for runs ingested before adcp#8332 or when no registry was available.';
