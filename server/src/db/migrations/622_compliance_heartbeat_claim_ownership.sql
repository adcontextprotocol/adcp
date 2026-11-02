-- The heartbeat claims a whole batch of agents up front by pushing
-- next_compliance_check_at out for the worst-case batch duration. When the worker
-- process dies mid-batch nothing releases that claim. These columns record who
-- holds a claim, whether the agent's suite actually started, and how many times
-- a process died while that agent's suite was running, so the next run can
-- release innocent claims immediately and back off the agent that was running.
ALTER TABLE agent_registry_metadata
  ADD COLUMN IF NOT EXISTS heartbeat_claim_owner TEXT,
  ADD COLUMN IF NOT EXISTS heartbeat_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS heartbeat_orphan_streak INTEGER NOT NULL DEFAULT 0;
