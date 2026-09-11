ALTER TABLE agent_compliance_runs
  ADD COLUMN IF NOT EXISTS runner_capability_version TEXT;

COMMENT ON COLUMN agent_compliance_runs.runner_capability_version IS
  'Runner capability version recorded at execution time; NULL when not recorded, including historical runs.';
