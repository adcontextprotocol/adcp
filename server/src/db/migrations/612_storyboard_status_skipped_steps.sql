-- Persist cascaded prerequisite skip evidence for the owner storyboard
-- drill-down (adcp#7798). skipped_count alone left operators with
-- "N steps skipped" and no step id, prerequisite, or runner reason.

ALTER TABLE agent_storyboard_status
  ADD COLUMN IF NOT EXISTS skipped_steps_jsonb JSONB;

COMMENT ON COLUMN agent_storyboard_status.skipped_steps_jsonb IS
  'Up to 5 cascaded prerequisite skips: step id/title/task, runner skip reason and redacted detail, and the nearest earlier non-passing step in the storyboard. Owner-scoped in public API responses.';
