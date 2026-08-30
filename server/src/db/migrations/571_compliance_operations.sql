-- Track in-flight and completed compliance refresh operations so the
-- async refresh endpoint (#7083) can return 202 immediately, coalesce
-- duplicate in-flight runs per agent URL across VMs, and let callers
-- poll for completion.
--
-- The unique partial index on (agent_url) WHERE status = 'pending'
-- enforces at most one in-flight operation per agent, which is the
-- cross-VM coalescing lock. comply() still runs in-process; this table
-- is the coordination primitive, not a job queue.

CREATE TABLE compliance_operations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_url       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'failed')),
  triggered_by    TEXT NOT NULL DEFAULT 'manual',
  triggered_org_id TEXT,
  user_id         TEXT,
  run_id          UUID,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX compliance_operations_pending_agent
  ON compliance_operations (agent_url)
  WHERE status = 'pending';

CREATE INDEX compliance_operations_agent_created
  ON compliance_operations (agent_url, created_at DESC);
