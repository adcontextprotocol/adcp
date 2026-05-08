-- Add 'owner_test' to triggered_by CHECK constraints in compliance tables.
-- Owner-triggered storyboard runs (via evaluate_agent_quality) now write to
-- canonical compliance state, distinguished from heartbeat and dashboard-manual
-- runs by triggered_by = 'owner_test'. See issue #4247.

ALTER TABLE agent_compliance_runs
  DROP CONSTRAINT IF EXISTS valid_triggered_by,
  ADD CONSTRAINT valid_triggered_by CHECK (
    triggered_by IN ('heartbeat', 'manual', 'webhook', 'owner_test')
  );

ALTER TABLE agent_storyboard_status
  DROP CONSTRAINT IF EXISTS valid_storyboard_triggered_by,
  ADD CONSTRAINT valid_storyboard_triggered_by CHECK (
    triggered_by IS NULL OR triggered_by IN ('heartbeat', 'manual', 'webhook', 'owner_test')
  );
