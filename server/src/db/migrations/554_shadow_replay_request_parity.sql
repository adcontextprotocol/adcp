-- Version 2 shadow traces bind the complete provider request and the explicit
-- official-docs capability profile. Version 1 rows are short-lived historical
-- records and remain readable only so the resolver can reject them cleanly.

ALTER TABLE addie_shadow_replay_traces
  DROP CONSTRAINT IF EXISTS addie_shadow_replay_traces_capture_version_check;

ALTER TABLE addie_shadow_replay_traces
  ALTER COLUMN capture_version SET DEFAULT 2,
  ADD CONSTRAINT addie_shadow_replay_traces_capture_version_check
    CHECK (capture_version IN (1, 2));

-- A Slack thread can contain several independently attributable questions.
-- The queue still admits at most one active pointer per thread, but historical
-- trace rows must not make every later opportunity fail a uniqueness check.
ALTER TABLE addie_shadow_replay_traces
  DROP CONSTRAINT IF EXISTS addie_shadow_replay_traces_thread_id_key;

ALTER TABLE addie_shadow_replay_traces
  ADD COLUMN capability_profile VARCHAR(64),
  ADD COLUMN capability_policy_version VARCHAR(64),
  ADD COLUMN approved_tool_names JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(approved_tool_names) = 'array'),
  ADD COLUMN message_payload_hmacs JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(message_payload_hmacs) = 'array'),
  ADD COLUMN provider_request_hmac CHAR(64)
    CHECK (provider_request_hmac IS NULL OR provider_request_hmac ~ '^[0-9a-f]{64}$'),
  ADD COLUMN capture_status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (capture_status IN ('pending', 'verified', 'skipped', 'error')),
  ADD COLUMN capture_reason VARCHAR(96)
    CHECK (capture_reason IS NULL OR capture_reason ~ '^[a-z0-9_]+$'),
  ADD COLUMN capture_completed_at TIMESTAMPTZ,
  ADD CONSTRAINT addie_shadow_replay_traces_v2_request_boundary_check CHECK (
    capture_version = 1 OR (
      capability_profile IS NOT NULL
      AND capability_policy_version IS NOT NULL
      AND jsonb_array_length(approved_tool_names) > 0
      AND jsonb_array_length(message_payload_hmacs) > 0
      AND provider_request_hmac IS NOT NULL
    )
  );

CREATE INDEX idx_shadow_replay_traces_capture_pending
  ON addie_shadow_replay_traces (created_at, trace_id)
  WHERE capture_version = 2 AND capture_status = 'pending';

CREATE TABLE addie_shadow_replay_capture_attempts (
  attempt_id UUID PRIMARY KEY,
  thread_id UUID NOT NULL REFERENCES addie_threads(thread_id) ON DELETE CASCADE,
  source_question_message_id UUID UNIQUE
    REFERENCES addie_thread_messages(message_id) ON DELETE CASCADE,
  capability_profile VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'captured', 'skipped', 'error')),
  reason VARCHAR(96) NOT NULL DEFAULT 'capture_pending'
    CHECK (reason ~ '^[a-z0-9_]+$'),
  trace_id UUID UNIQUE
    REFERENCES addie_shadow_replay_traces(trace_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  retained_until TIMESTAMPTZ NOT NULL,
  CHECK (retained_until > created_at)
);

CREATE INDEX idx_shadow_replay_capture_attempts_retention
  ON addie_shadow_replay_capture_attempts (retained_until);

COMMENT ON COLUMN addie_shadow_replay_traces.provider_request_hmac IS
  'HMAC of the exact first provider SDK request: model, limits, system, tools, messages, and betas';
COMMENT ON COLUMN addie_shadow_replay_traces.capability_profile IS
  'Explicit production capability profile; never inferred from mutable evaluation metadata';
COMMENT ON COLUMN addie_shadow_replay_traces.capture_status IS
  'Per-opportunity capture-parity outcome used for unbiased rollout accounting';
COMMENT ON TABLE addie_shadow_replay_traces IS
  'Restricted, expiring HMAC authorization records with separate categorical capture outcomes';
COMMENT ON TABLE addie_shadow_replay_capture_attempts IS
  'Per-opportunity categorical capture ledger; contains no transcript, prompt, member, or channel payloads';
