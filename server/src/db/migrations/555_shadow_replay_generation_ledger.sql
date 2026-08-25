-- One immutable, hash-only generation outcome per signed shadow replay trace.
-- Raw questions, prompts, tool inputs/results, and generated answers are never
-- stored here. A trace can be claimed once; interrupted paid calls are closed
-- categorically and are not retried.

CREATE TABLE addie_shadow_replay_generations (
  trace_id UUID PRIMARY KEY
    REFERENCES addie_shadow_replay_traces(trace_id) ON DELETE CASCADE,
  execution_policy_version VARCHAR(64) NOT NULL
    CHECK (length(execution_policy_version) > 0),
  status VARCHAR(32) NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'blocked', 'error')),
  reason VARCHAR(96) NOT NULL DEFAULT 'generation_started'
    CHECK (reason ~ '^[a-z0-9_]+$'),
  model VARCHAR(160) NOT NULL CHECK (length(model) > 0),
  quota_date DATE NOT NULL,
  quota_slot SMALLINT NOT NULL CHECK (quota_slot BETWEEN 1 AND 100),
  first_provider_request_hmac CHAR(64) NOT NULL
    CHECK (first_provider_request_hmac ~ '^[0-9a-f]{64}$'),
  output_hmac CHAR(64)
    CHECK (output_hmac IS NULL OR output_hmac ~ '^[0-9a-f]{64}$'),
  output_bytes INTEGER NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
  invocation_hmacs JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (
      jsonb_typeof(invocation_hmacs) = 'array'
      AND jsonb_array_length(invocation_hmacs) <= 4
    ),
  tool_executions JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (
      jsonb_typeof(tool_executions) = 'array'
      AND jsonb_array_length(tool_executions) <= 8
    ),
  blocked_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (
      jsonb_typeof(blocked_capabilities) = 'array'
      AND jsonb_array_length(blocked_capabilities) <= 32
    ),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  retained_until TIMESTAMPTZ NOT NULL,
  CHECK (heartbeat_at >= started_at),
  CHECK (retained_until > started_at),
  CHECK (status = 'running' OR completed_at IS NOT NULL),
  CHECK (status <> 'succeeded' OR output_hmac IS NOT NULL),
  UNIQUE (quota_date, quota_slot)
);

CREATE INDEX idx_shadow_replay_generations_retention
  ON addie_shadow_replay_generations (retained_until);

CREATE INDEX idx_shadow_replay_generations_started
  ON addie_shadow_replay_generations (started_at, status);

COMMENT ON TABLE addie_shadow_replay_generations IS
  'One-attempt, HMAC-only execution ledger for bounded Addie shadow replay generation';
COMMENT ON COLUMN addie_shadow_replay_generations.first_provider_request_hmac IS
  'Signed-capture HMAC that the executor must match immediately before its first provider call';
COMMENT ON COLUMN addie_shadow_replay_generations.tool_executions IS
  'Bounded categorical tool evidence with per-trace HMACs; never raw inputs or results';
