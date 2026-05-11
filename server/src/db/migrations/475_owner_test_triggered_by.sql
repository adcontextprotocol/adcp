-- Add 'owner_test' to triggered_by CHECK constraints in compliance tables.
-- Owner-triggered storyboard runs (via evaluate_agent_quality) now write to
-- canonical compliance state, distinguished from heartbeat and dashboard-manual
-- runs by triggered_by = 'owner_test'. See issue #4247.

-- DDL lock guard: a long-running app transaction (compliance heartbeat, owner
-- test, snapshot read) holds AccessShareLock on these tables. ADD CONSTRAINT
-- needs AccessExclusiveLock and would queue indefinitely behind those readers,
-- blocking every subsequent statement on the table for the duration. The
-- timeout fails the migration loud instead of stalling the deploy; on
-- failure, retry the release after the contending transaction settles.
SET lock_timeout = '5s';

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

RESET lock_timeout;
