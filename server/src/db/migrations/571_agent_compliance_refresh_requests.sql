-- Durable lifecycle for owner/admin-triggered agent refreshes (#7083).
--
-- The public edge cannot hold the full compliance suite open. Admission is
-- committed before the API returns 202, and the worker claims each request
-- with an expiring lease. Only references to saved credentials are stored;
-- credential material is resolved again by the worker.

CREATE TABLE agent_compliance_refresh_requests (
  id UUID PRIMARY KEY,
  agent_url TEXT NOT NULL CHECK (char_length(agent_url) BETWEEN 1 AND 2048),
  owner_org_id TEXT,
  requester_type TEXT NOT NULL CHECK (requester_type IN ('user', 'static_admin')),
  requested_by_user_id TEXT,
  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('owner_test', 'manual')),
  test_session_id TEXT NOT NULL UNIQUE CHECK (char_length(test_session_id) BETWEEN 1 AND 255),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 5),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  last_attempted_at TIMESTAMPTZ,
  probe_result_json JSONB,
  auth_available BOOLEAN,
  result_json JSONB,
  last_error_code TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_compliance_refresh_requester_identity CHECK (
    (requester_type = 'user' AND requested_by_user_id IS NOT NULL)
    OR (requester_type = 'static_admin' AND requested_by_user_id IS NULL)
  ),
  CONSTRAINT agent_compliance_refresh_owner_shape CHECK (
    (triggered_by = 'owner_test' AND owner_org_id IS NOT NULL)
    OR (triggered_by = 'manual' AND owner_org_id IS NULL)
  ),
  CONSTRAINT agent_compliance_refresh_lease_shape CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT agent_compliance_refresh_result_shape CHECK (
    (status = 'succeeded' AND result_json IS NOT NULL)
    OR (status <> 'succeeded' AND result_json IS NULL)
  ),
  CONSTRAINT agent_compliance_refresh_completion_shape CHECK (
    (status IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
    OR (status IN ('queued', 'running') AND completed_at IS NULL)
  )
);

CREATE UNIQUE INDEX idx_agent_compliance_refresh_one_active
  ON agent_compliance_refresh_requests (agent_url)
  WHERE status IN ('queued', 'running');

CREATE INDEX idx_agent_compliance_refresh_due
  ON agent_compliance_refresh_requests (available_at, created_at)
  WHERE status = 'queued';

CREATE INDEX idx_agent_compliance_refresh_expired_lease
  ON agent_compliance_refresh_requests (lease_expires_at)
  WHERE status = 'running';

CREATE INDEX idx_agent_compliance_refresh_requester_created
  ON agent_compliance_refresh_requests (requester_type, requested_by_user_id, created_at DESC);

CREATE INDEX idx_agent_compliance_refresh_agent_created
  ON agent_compliance_refresh_requests (agent_url, created_at DESC);

CREATE INDEX idx_agent_compliance_refresh_terminal_completed
  ON agent_compliance_refresh_requests (completed_at, id)
  WHERE status IN ('succeeded', 'failed');

COMMENT ON TABLE agent_compliance_refresh_requests IS
  'Durable, owner-scoped lifecycle for long-running registry probe and compliance refresh operations.';

ALTER TABLE agent_compliance_runs
  ADD COLUMN refresh_operation_id UUID REFERENCES agent_compliance_refresh_requests(id) ON DELETE SET NULL;

ALTER TABLE agent_compliance_runs
  ADD CONSTRAINT agent_compliance_runs_refresh_operation_unique UNIQUE (refresh_operation_id);
