-- Privacy-preserving, immutable authorization records for suppressed-response replay.
-- Raw questions, member/channel context, prompts, schemas, and tool results remain
-- in their canonical stores or in memory; this table contains only references,
-- bounded metadata, and domain-separated keyed digests.

CREATE TABLE IF NOT EXISTS addie_shadow_replay_traces (
  trace_id UUID PRIMARY KEY,
  capture_version SMALLINT NOT NULL DEFAULT 1 CHECK (capture_version = 1),
  thread_id UUID NOT NULL UNIQUE REFERENCES addie_threads(thread_id) ON DELETE CASCADE,
  source_question_message_id UUID NOT NULL UNIQUE
    REFERENCES addie_thread_messages(message_id) ON DELETE CASCADE,
  source_slack_message_ts TEXT NOT NULL CHECK (length(source_slack_message_ts) BETWEEN 1 AND 64),
  source_config_version_id INTEGER NOT NULL REFERENCES addie_config_versions(version_id),
  hash_key_version VARCHAR(64) NOT NULL CHECK (length(hash_key_version) > 0),
  policy_version VARCHAR(64) NOT NULL CHECK (length(policy_version) > 0),
  capture_salt CHAR(32) NOT NULL CHECK (capture_salt ~ '^[0-9a-f]{32}$'),
  effective_model VARCHAR(160) NOT NULL CHECK (length(effective_model) > 0),
  si_retrieval_present BOOLEAN NOT NULL,
  provider_web_search_enabled BOOLEAN NOT NULL,
  message_count INTEGER NOT NULL CHECK (message_count > 0),
  question_hmac CHAR(64) NOT NULL CHECK (question_hmac ~ '^[0-9a-f]{64}$'),
  source_binding_hmac CHAR(64) NOT NULL CHECK (source_binding_hmac ~ '^[0-9a-f]{64}$'),
  member_context_hmac CHAR(64) NOT NULL CHECK (member_context_hmac ~ '^[0-9a-f]{64}$'),
  channel_context_hmac CHAR(64) NOT NULL CHECK (channel_context_hmac ~ '^[0-9a-f]{64}$'),
  plan_hmac CHAR(64) NOT NULL CHECK (plan_hmac ~ '^[0-9a-f]{64}$'),
  si_retrieval_hmac CHAR(64) NOT NULL CHECK (si_retrieval_hmac ~ '^[0-9a-f]{64}$'),
  request_context_hmac CHAR(64) NOT NULL CHECK (request_context_hmac ~ '^[0-9a-f]{64}$'),
  docs_corpus_hmac CHAR(64) NOT NULL CHECK (docs_corpus_hmac ~ '^[0-9a-f]{64}$'),
  system_block_hmacs JSONB NOT NULL CHECK (jsonb_typeof(system_block_hmacs) = 'array'),
  tool_schema_hmacs JSONB NOT NULL CHECK (jsonb_typeof(tool_schema_hmacs) = 'array'),
  authorization_hmac CHAR(64) NOT NULL CHECK (authorization_hmac ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  retained_until TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (retained_until >= expires_at)
);

CREATE INDEX IF NOT EXISTS idx_shadow_replay_traces_pending
  ON addie_shadow_replay_traces (expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_shadow_replay_traces_retention
  ON addie_shadow_replay_traces (retained_until);

COMMENT ON TABLE addie_shadow_replay_traces IS
  'Restricted, expiring HMAC-only authorization records for attributable Addie shadow replay';
COMMENT ON COLUMN addie_shadow_replay_traces.authorization_hmac IS
  'Authenticates the bounded trace record; mutable thread context is never an authority';

-- Legacy pending rows copied private replay inputs into mutable thread JSON.
-- They cannot be upgraded into signed traces after the fact, so redact and
-- close them explicitly rather than silently trusting/backfilling them.
UPDATE addie_threads
SET context = (
  context - ARRAY[
    'shadow_eval_channel_id', 'shadow_eval_thread_ts', 'shadow_eval_question_ts',
    'shadow_eval_tool_sets', 'shadow_eval_question',
    'shadow_eval_source_question_message_id', 'shadow_eval_source_message_id',
    'shadow_eval_source_user_id', 'shadow_eval_source_config_version_id',
    'shadow_eval_router_decision', 'shadow_eval_si_retrieval',
    'shadow_eval_answer_response', 'shadow_eval_shadow_response',
    'shadow_eval_human_response'
  ]::text[]
) || jsonb_build_object(
  'shadow_eval_status', 'skipped',
  'shadow_eval_type', 'suppressed_opportunity',
  'shadow_eval_source', 'suppressed',
  'shadow_eval_completed_at', NOW(),
  'shadow_eval_replay_error', 'legacy_unsigned_trace_redacted'
),
updated_at = NOW()
WHERE context->>'shadow_eval_status' = 'pending'
  AND context->>'shadow_eval_trace_id' IS NULL
  AND COALESCE(context->>'shadow_eval_type', '') NOT IN (
    'corrected_answer', 'historical_corrected_answer'
  )
  AND COALESCE(context->>'shadow_eval_source', '') NOT IN (
    'addie_corrected_capture', 'backfill'
  );

UPDATE addie_threads
SET context = CASE
  WHEN context->'shadow_eval_result' ? 'gap_details' THEN
    jsonb_set(
      context - ARRAY[
        'shadow_eval_channel_id', 'shadow_eval_thread_ts', 'shadow_eval_question_ts',
        'shadow_eval_tool_sets', 'shadow_eval_question',
        'shadow_eval_source_question_message_id', 'shadow_eval_source_message_id',
        'shadow_eval_source_user_id', 'shadow_eval_source_config_version_id',
        'shadow_eval_router_decision', 'shadow_eval_si_retrieval',
        'shadow_eval_answer_response', 'shadow_eval_shadow_response',
        'shadow_eval_human_response'
      ]::text[],
      '{shadow_eval_result,gap_details}',
      '"legacy_detail_redacted"'::jsonb,
      false
    )
  ELSE context - ARRAY[
    'shadow_eval_channel_id', 'shadow_eval_thread_ts', 'shadow_eval_question_ts',
    'shadow_eval_tool_sets', 'shadow_eval_question',
    'shadow_eval_source_question_message_id', 'shadow_eval_source_message_id',
    'shadow_eval_source_user_id', 'shadow_eval_source_config_version_id',
    'shadow_eval_router_decision', 'shadow_eval_si_retrieval',
    'shadow_eval_answer_response', 'shadow_eval_shadow_response',
    'shadow_eval_human_response'
  ]::text[]
END,
flag_reason = CASE
  WHEN flagged AND (
    (
      context ?| ARRAY[
      'shadow_eval_channel_id', 'shadow_eval_thread_ts', 'shadow_eval_question_ts',
      'shadow_eval_tool_sets', 'shadow_eval_question',
      'shadow_eval_source_question_message_id', 'shadow_eval_source_message_id',
      'shadow_eval_source_user_id', 'shadow_eval_source_config_version_id',
      'shadow_eval_router_decision', 'shadow_eval_si_retrieval',
      'shadow_eval_answer_response', 'shadow_eval_shadow_response',
      'shadow_eval_human_response'
      ]
      AND COALESCE(context->>'shadow_eval_type', '') NOT IN (
        'corrected_answer', 'historical_corrected_answer'
      )
      AND COALESCE(context->>'shadow_eval_source', '') NOT IN (
        'addie_corrected_capture', 'backfill'
      )
    )
    OR context->>'shadow_eval_type' = 'suppressed_opportunity'
    OR context->>'shadow_eval_source' = 'suppressed'
  ) THEN 'Suppressed-opportunity evaluation (legacy details redacted)'
  ELSE flag_reason
END,
updated_at = NOW()
WHERE (
    context ?| ARRAY[
    'shadow_eval_channel_id', 'shadow_eval_thread_ts', 'shadow_eval_question_ts',
    'shadow_eval_tool_sets', 'shadow_eval_question',
    'shadow_eval_source_question_message_id', 'shadow_eval_source_message_id',
    'shadow_eval_source_user_id', 'shadow_eval_source_config_version_id',
    'shadow_eval_router_decision', 'shadow_eval_si_retrieval',
    'shadow_eval_answer_response', 'shadow_eval_shadow_response',
    'shadow_eval_human_response'
    ]
    AND COALESCE(context->>'shadow_eval_type', '') NOT IN (
      'corrected_answer', 'historical_corrected_answer'
    )
    AND COALESCE(context->>'shadow_eval_source', '') NOT IN (
      'addie_corrected_capture', 'backfill'
    )
  )
   OR context->>'shadow_eval_type' = 'suppressed_opportunity'
   OR context->>'shadow_eval_source' = 'suppressed';
