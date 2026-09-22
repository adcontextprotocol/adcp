-- Durable coalescing and lease ownership for Addie's interactive compliance
-- evaluations. Chat/tool checkpoint rows are deliberately not part of this
-- authority: an execution exists only after this table grants a live lease.

CREATE TABLE addie_agent_quality_evaluations (
  id UUID PRIMARY KEY,
  request_key TEXT NOT NULL CHECK (request_key ~ '^[a-f0-9]{64}$'),
  agent_url TEXT NOT NULL CHECK (char_length(agent_url) BETWEEN 1 AND 2048),
  compliance_target TEXT NOT NULL CHECK (char_length(compliance_target) BETWEEN 1 AND 160),
  tracks_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tracks_json) = 'array'),
  auth_scope_hash TEXT NOT NULL CHECK (auth_scope_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'expired')),
  owner_id TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  receipt_metadata_json JSONB,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT addie_agent_quality_lease_shape CHECK (
    (status = 'running' AND owner_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
    OR
    (status <> 'running' AND owner_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_addie_agent_quality_one_active_request
  ON addie_agent_quality_evaluations (request_key)
  WHERE status = 'running';

CREATE INDEX idx_addie_agent_quality_expired_lease
  ON addie_agent_quality_evaluations (lease_expires_at)
  WHERE status = 'running';

CREATE INDEX idx_addie_agent_quality_agent_started
  ON addie_agent_quality_evaluations (agent_url, started_at DESC);

COMMENT ON TABLE addie_agent_quality_evaluations IS
  'Durable execution authority for Addie evaluate_agent_quality calls; hidden message/tool checkpoints are not executions.';

ALTER TABLE agent_compliance_runs
  ADD COLUMN agent_quality_evaluation_id UUID
    REFERENCES addie_agent_quality_evaluations(id) ON DELETE SET NULL;

ALTER TABLE agent_compliance_runs
  ADD CONSTRAINT agent_compliance_runs_quality_evaluation_unique
  UNIQUE (agent_quality_evaluation_id);
