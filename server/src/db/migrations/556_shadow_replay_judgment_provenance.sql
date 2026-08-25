-- Version 3 binds an optional exact human response to the signed replay trace
-- without copying its author or content. Judgment outcomes remain categorical
-- and HMAC-only so neither model output nor Slack transcript text is retained.

ALTER TABLE addie_shadow_replay_traces
  DROP CONSTRAINT IF EXISTS addie_shadow_replay_traces_capture_version_check,
  DROP CONSTRAINT IF EXISTS addie_shadow_replay_traces_human_evidence_all_or_none;

ALTER TABLE addie_shadow_replay_traces
  ALTER COLUMN capture_version SET DEFAULT 3,
  ADD COLUMN IF NOT EXISTS capture_parity_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT addie_shadow_replay_traces_capture_version_check
    CHECK (capture_version IN (1, 2, 3)),
  ADD COLUMN IF NOT EXISTS human_response_slack_message_ts TEXT
    CHECK (
      human_response_slack_message_ts IS NULL
      OR length(human_response_slack_message_ts) BETWEEN 1 AND 64
    ),
  ADD COLUMN IF NOT EXISTS human_response_user_hmac CHAR(64)
    CHECK (
      human_response_user_hmac IS NULL
      OR human_response_user_hmac ~ '^[0-9a-f]{64}$'
    ),
  ADD COLUMN IF NOT EXISTS human_response_content_hmac CHAR(64)
    CHECK (
      human_response_content_hmac IS NULL
      OR human_response_content_hmac ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT addie_shadow_replay_traces_human_evidence_all_or_none CHECK (
    (
      human_response_slack_message_ts IS NULL
      AND human_response_user_hmac IS NULL
      AND human_response_content_hmac IS NULL
    ) OR (
      capture_version = 3
      AND human_response_slack_message_ts IS NOT NULL
      AND human_response_user_hmac IS NOT NULL
      AND human_response_content_hmac IS NOT NULL
    )
  );

DROP INDEX IF EXISTS idx_shadow_replay_traces_capture_pending;
CREATE INDEX idx_shadow_replay_traces_capture_pending
  ON addie_shadow_replay_traces (created_at, trace_id)
  WHERE capture_version = 3 AND capture_status = 'pending';

-- Attempts predate v3 and can fail before a trace exists, so trace joins cannot
-- reliably identify their cohort. Existing rows are v2; new code writes v3
-- explicitly, leaving the default at 2 for safe overlap with old processes.
ALTER TABLE addie_shadow_replay_capture_attempts
  ADD COLUMN IF NOT EXISTS capture_version SMALLINT NOT NULL DEFAULT 2
    CHECK (capture_version IN (2, 3));

CREATE INDEX IF NOT EXISTS idx_shadow_replay_capture_attempts_version_created
  ON addie_shadow_replay_capture_attempts (capture_version, created_at);

-- Version-2 captures did not authenticate an exact comparison target. Never
-- upgrade them in place or let a later deployment mistake them for v3 input.
UPDATE addie_shadow_replay_generations generation
SET status = 'error',
    reason = 'trace_capture_version_superseded',
    completed_at = NOW()
FROM addie_shadow_replay_traces trace
WHERE trace.trace_id = generation.trace_id
  AND trace.capture_version = 2
  AND trace.capture_status = 'pending'
  AND generation.status = 'running';

UPDATE addie_shadow_replay_traces
SET capture_status = 'skipped',
    capture_reason = 'trace_capture_version_superseded',
    capture_completed_at = NOW()
WHERE capture_version = 2
  AND capture_status = 'pending';

UPDATE addie_threads thread
SET context = COALESCE(thread.context, '{}'::jsonb) || jsonb_build_object(
      'shadow_eval_status', 'skipped',
      'shadow_eval_type', 'suppressed_opportunity',
      'shadow_eval_source', 'suppressed',
      'shadow_eval_completed_at', NOW(),
      'shadow_eval_replay_error', 'trace_capture_version_superseded',
      'shadow_eval_capture_parity_verified', false
    ),
    updated_at = NOW()
FROM addie_shadow_replay_traces trace
WHERE trace.thread_id = thread.thread_id
  AND trace.capture_version = 2
  AND trace.capture_reason = 'trace_capture_version_superseded'
  AND thread.context->>'shadow_eval_trace_id' = trace.trace_id::text;

CREATE TABLE IF NOT EXISTS addie_shadow_replay_judgments (
  trace_id UUID PRIMARY KEY
    REFERENCES addie_shadow_replay_generations(trace_id) ON DELETE CASCADE,
  status VARCHAR(32) NOT NULL
    CHECK (status IN ('judged', 'deterministic_failure', 'skipped', 'error')),
  reason VARCHAR(96) NOT NULL CHECK (reason ~ '^[a-z0-9_]+$'),
  judgment_policy_version VARCHAR(64) NOT NULL
    CHECK (length(judgment_policy_version) > 0),
  evaluation_valid BOOLEAN NOT NULL,
  evaluation_skipped BOOLEAN NOT NULL,
  knowledge_gap BOOLEAN,
  gap_severity VARCHAR(16)
    CHECK (gap_severity IS NULL OR gap_severity IN ('none', 'minor', 'significant', 'critical')),
  shadow_quality VARCHAR(32)
    CHECK (shadow_quality IS NULL OR shadow_quality IN ('better', 'equivalent', 'worse', 'different_focus')),
  deterministic_failure_labels TEXT[] NOT NULL DEFAULT '{}'::text[]
    CHECK (
      cardinality(deterministic_failure_labels) <= 16
      AND array_position(deterministic_failure_labels, NULL) IS NULL
      AND deterministic_failure_labels <@ ARRAY[
        'length_cap', 'default_template', 'structured_heavy',
        'comprehensive_dump', 'signin_opener', 'banned_ritual'
      ]::text[]
      AND octet_length(array_to_string(deterministic_failure_labels, ',')) <= 2048
      AND (
        cardinality(deterministic_failure_labels) = 0
        OR array_to_string(deterministic_failure_labels, ',')
          ~ '^[a-z0-9_]{1,96}(,[a-z0-9_]{1,96})*$'
      )
    ),
  shape_word_count INTEGER NOT NULL CHECK (shape_word_count BETWEEN 0 AND 100000),
  shape_expected_max_words INTEGER NOT NULL
    CHECK (shape_expected_max_words BETWEEN 1 AND 100000),
  shape_ratio_to_expected DOUBLE PRECISION NOT NULL
    CHECK (shape_ratio_to_expected >= 0 AND shape_ratio_to_expected <= 1000),
  judge_provider VARCHAR(16)
    CHECK (judge_provider IS NULL OR judge_provider IN ('anthropic', 'openai', 'google', 'unknown')),
  judge_model VARCHAR(160),
  self_judged BOOLEAN,
  judge_prompt_version VARCHAR(64)
    CHECK (judge_prompt_version IS NULL OR length(judge_prompt_version) BETWEEN 1 AND 64),
  judge_prompt_hmac CHAR(64)
    CHECK (judge_prompt_hmac IS NULL OR judge_prompt_hmac ~ '^[0-9a-f]{64}$'),
  judge_request_hmac CHAR(64)
    CHECK (judge_request_hmac IS NULL OR judge_request_hmac ~ '^[0-9a-f]{64}$'),
  judge_response_hmac CHAR(64)
    CHECK (judge_response_hmac IS NULL OR judge_response_hmac ~ '^[0-9a-f]{64}$'),
  question_hmac CHAR(64) NOT NULL CHECK (question_hmac ~ '^[0-9a-f]{64}$'),
  source_output_hmac CHAR(64) NOT NULL
    CHECK (source_output_hmac ~ '^[0-9a-f]{64}$'),
  human_evidence_content_hmac CHAR(64)
    CHECK (human_evidence_content_hmac IS NULL OR human_evidence_content_hmac ~ '^[0-9a-f]{64}$'),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  retained_until TIMESTAMPTZ NOT NULL,
  CHECK (completed_at >= started_at),
  CHECK (retained_until > completed_at),
  CHECK (
    (judge_model IS NULL AND judge_provider IS NULL AND self_judged IS NULL
      AND judge_prompt_version IS NULL AND judge_prompt_hmac IS NULL
      AND judge_request_hmac IS NULL AND judge_response_hmac IS NULL)
    OR
    (judge_model IS NOT NULL AND judge_provider IS NOT NULL AND self_judged IS NOT NULL
      AND judge_prompt_version IS NOT NULL AND judge_prompt_hmac IS NOT NULL
      AND judge_request_hmac IS NOT NULL)
  ),
  CHECK (
    status <> 'judged' OR (
      evaluation_valid
      AND NOT evaluation_skipped
      AND knowledge_gap IS NOT NULL
      AND gap_severity IS NOT NULL
      AND shadow_quality IS NOT NULL
      AND judge_provider IS NOT NULL
      AND judge_model IS NOT NULL
      AND self_judged = FALSE
      AND judge_prompt_version IS NOT NULL
      AND judge_prompt_hmac IS NOT NULL
      AND judge_request_hmac IS NOT NULL
      AND judge_response_hmac IS NOT NULL
      AND human_evidence_content_hmac IS NOT NULL
    )
  ),
  CHECK (
    status = 'judged' OR (
      knowledge_gap IS NULL
      AND gap_severity IS NULL
      AND shadow_quality IS NULL
    )
  ),
  CHECK (
    status <> 'deterministic_failure'
    OR (evaluation_valid AND NOT evaluation_skipped
      AND cardinality(deterministic_failure_labels) > 0
      AND judge_model IS NULL)
  ),
  CHECK (
    status <> 'skipped'
    OR (NOT evaluation_valid AND evaluation_skipped AND judge_model IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_shadow_replay_judgments_completed
  ON addie_shadow_replay_judgments (completed_at, status);

COMMENT ON TABLE addie_shadow_replay_judgments IS
  'Categorical, HMAC-only judgment outcomes for attributable shadow replay; never raw text';
COMMENT ON COLUMN addie_shadow_replay_traces.human_response_content_hmac IS
  'Per-trace HMAC of the exact optional human comparison response; content stays in its canonical source';
COMMENT ON COLUMN addie_shadow_replay_capture_attempts.capture_version IS
  'Capture cohort version written before fallible trace creation; existing migration-554 attempts are v2';
