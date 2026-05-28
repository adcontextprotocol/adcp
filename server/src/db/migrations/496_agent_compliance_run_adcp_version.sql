-- Migration 496: record the AdCP compliance target and bundle version for each run.
--
-- Compliance execution must be auditable by version. A run row now records
-- both the requested target (for example '3.0' or '3.1-beta') and the
-- concrete compliance cache version used by the runner (for example '3.0.12').
-- The materialized status row mirrors the latest run's values for cheap
-- dashboard reads.

ALTER TABLE agent_compliance_runs
  ADD COLUMN IF NOT EXISTS requested_compliance_target TEXT;

COMMENT ON COLUMN agent_compliance_runs.requested_compliance_target IS
  'Requested compliance target before alias resolution, e.g. 3.0 or 3.1-beta. NULL only for legacy rows recorded before this column existed.';

ALTER TABLE agent_compliance_runs
  ADD COLUMN IF NOT EXISTS adcp_version TEXT;

COMMENT ON COLUMN agent_compliance_runs.adcp_version IS
  'Concrete AdCP compliance bundle version used for this run, e.g. 3.0.12. NULL only for legacy rows recorded before this column existed.';

ALTER TABLE agent_compliance_status
  ADD COLUMN IF NOT EXISTS requested_compliance_target TEXT;

COMMENT ON COLUMN agent_compliance_status.requested_compliance_target IS
  'Requested compliance target from the latest materialized run for this agent, e.g. 3.0 or 3.1-beta. NULL only until the next run after migration.';

ALTER TABLE agent_compliance_status
  ADD COLUMN IF NOT EXISTS adcp_version TEXT;

COMMENT ON COLUMN agent_compliance_status.adcp_version IS
  'Concrete AdCP compliance bundle version from the latest materialized run for this agent. NULL only until the next run after migration.';

ALTER TABLE agent_storyboard_status
  ADD COLUMN IF NOT EXISTS requested_compliance_target TEXT;

COMMENT ON COLUMN agent_storyboard_status.requested_compliance_target IS
  'Requested compliance target from the run that produced this storyboard verdict, e.g. 3.0 or 3.1-beta. NULL only for legacy rows recorded before this column existed.';

ALTER TABLE agent_storyboard_status
  ADD COLUMN IF NOT EXISTS adcp_version TEXT;

COMMENT ON COLUMN agent_storyboard_status.adcp_version IS
  'Concrete AdCP compliance bundle version from the run that produced this storyboard verdict. NULL only for legacy rows recorded before this column existed.';
