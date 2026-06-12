-- Persist lightweight per-storyboard failure summaries for compliance UI
-- drill-downs. Full wire diagnostics remain in agent_compliance_step_diagnostics;
-- these columns are intentionally small enough for materialized dashboard reads.

ALTER TABLE agent_storyboard_status
  ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_storyboard_status
  ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_storyboard_status
  ADD COLUMN IF NOT EXISTS first_failed_step_id TEXT;

ALTER TABLE agent_storyboard_status
  ADD COLUMN IF NOT EXISTS first_failed_step_title TEXT;

ALTER TABLE agent_storyboard_status
  ADD COLUMN IF NOT EXISTS first_failed_step_task TEXT;

ALTER TABLE agent_storyboard_status
  ADD COLUMN IF NOT EXISTS first_failure_message TEXT;

COMMENT ON COLUMN agent_storyboard_status.failure_count IS
  'Number of root failing or actionable skipped steps in the storyboard verdict. Cascaded prerequisite skips are excluded.';

COMMENT ON COLUMN agent_storyboard_status.skipped_count IS
  'Number of cascaded prerequisite skips in the storyboard verdict.';

COMMENT ON COLUMN agent_storyboard_status.first_failed_step_id IS
  'First root failing or actionable skipped step id captured from the runner output.';

COMMENT ON COLUMN agent_storyboard_status.first_failed_step_title IS
  'First root failing or actionable skipped step title captured from the runner output.';

COMMENT ON COLUMN agent_storyboard_status.first_failed_step_task IS
  'Task/tool name for the first root failing or actionable skipped step.';

COMMENT ON COLUMN agent_storyboard_status.first_failure_message IS
  'Redacted runner error/detail text for the first root failing or actionable skipped step. Owner-scoped in public API responses.';
