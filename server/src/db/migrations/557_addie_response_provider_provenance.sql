-- Persist the provider identity returned by the model API separately from the
-- configured/requested model alias already stored in `model`.
-- Fail and retry deployment rather than waiting indefinitely for either hot
-- Addie table's brief ACCESS EXCLUSIVE metadata lock.
SET LOCAL lock_timeout = '5s';

ALTER TABLE addie_thread_messages
  ADD COLUMN IF NOT EXISTS model_execution_source VARCHAR(16),
  ADD COLUMN IF NOT EXISTS requested_model_provider VARCHAR(32),
  ADD COLUMN IF NOT EXISTS requested_model VARCHAR(256),
  ADD COLUMN IF NOT EXISTS model_provider VARCHAR(32),
  ADD COLUMN IF NOT EXISTS provider_model VARCHAR(256),
  ADD COLUMN IF NOT EXISTS provider_model_resolution VARCHAR(32),
  ADD COLUMN IF NOT EXISTS provider_fallback_reason VARCHAR(64),
  ADD COLUMN IF NOT EXISTS local_response_reason VARCHAR(64);

ALTER TABLE addie_thread_messages
  ADD CONSTRAINT addie_thread_messages_provider_values
    CHECK (
      (requested_model_provider IS NULL OR requested_model_provider IN ('anthropic', 'openai', 'google'))
      AND (model_provider IS NULL OR model_provider IN ('anthropic', 'openai', 'google'))
    ) NOT VALID,
  ADD CONSTRAINT addie_thread_messages_execution_source_values
    CHECK (model_execution_source IN ('provider', 'local', 'legacy')) NOT VALID,
  ADD CONSTRAINT addie_thread_messages_execution_assistant_only
    CHECK (model_execution_source IS NULL OR role = 'assistant') NOT VALID,
  ADD CONSTRAINT addie_thread_messages_provider_model_nonempty
    CHECK (
      (requested_model IS NULL OR length(btrim(requested_model)) BETWEEN 1 AND 256)
      AND (provider_model IS NULL OR length(btrim(provider_model)) BETWEEN 1 AND 256)
    ) NOT VALID,
  ADD CONSTRAINT addie_thread_messages_provider_fallback_reason_values
    CHECK (
      provider_fallback_reason IS NULL
      OR provider_fallback_reason IN (
        'primary_unavailable',
        'primary_rate_limited',
        'primary_timeout',
        'primary_capability_unsupported',
        'primary_policy_blocked'
      )
    ) NOT VALID,
  ADD CONSTRAINT addie_thread_messages_provider_model_resolution_values
    CHECK (
      provider_model_resolution IS NULL
      OR provider_model_resolution IN ('exact', 'provider_canonicalized', 'fallback')
    ) NOT VALID,
  ADD CONSTRAINT addie_thread_messages_local_response_reason_values
    CHECK (
      local_response_reason IS NULL
      OR local_response_reason IN (
        'cost_cap_exceeded',
        'provider_error',
        'stream_interrupted',
        'no_provider_response',
        'canned_response'
      )
    ) NOT VALID,
  ADD CONSTRAINT addie_thread_messages_provider_execution_atomic
    CHECK (
      (model_execution_source = 'legacy' AND requested_model_provider IS NULL AND requested_model IS NULL AND model_provider IS NULL AND provider_model IS NULL AND provider_model_resolution IS NULL AND provider_fallback_reason IS NULL AND local_response_reason IS NULL)
      OR (model_execution_source = 'provider' AND requested_model_provider IS NOT NULL AND requested_model IS NOT NULL AND model_provider IS NOT NULL AND provider_model IS NOT NULL AND provider_model_resolution IS NOT NULL AND local_response_reason IS NULL)
      OR (model_execution_source = 'local' AND ((requested_model_provider IS NULL AND requested_model IS NULL) OR (requested_model_provider IS NOT NULL AND requested_model IS NOT NULL)) AND model_provider IS NULL AND provider_model IS NULL AND provider_model_resolution IS NULL AND provider_fallback_reason IS NULL AND local_response_reason IS NOT NULL)
    ) NOT VALID,
  ADD CONSTRAINT addie_thread_messages_provider_fallback_consistent
    CHECK (
      model_execution_source IS DISTINCT FROM 'provider'
      OR (provider_model_resolution = 'exact' AND requested_model_provider = model_provider AND requested_model = provider_model AND provider_fallback_reason IS NULL)
      OR (provider_model_resolution = 'provider_canonicalized' AND requested_model_provider = model_provider AND requested_model <> provider_model AND provider_fallback_reason IS NULL)
      OR (provider_model_resolution = 'fallback' AND (requested_model_provider <> model_provider OR requested_model <> provider_model) AND provider_fallback_reason IS NOT NULL)
    ) NOT VALID;

-- Expand phase: keep the discriminator nullable until every pre-557 app
-- instance has drained. The application requires it for new assistant writes;
-- a later contract migration can add the database-level required check.

COMMENT ON COLUMN addie_thread_messages.model IS
  'Configured/requested model alias retained for compatibility.';
COMMENT ON COLUMN addie_thread_messages.requested_model_provider IS
  'Provider selected before execution or fallback.';
COMMENT ON COLUMN addie_thread_messages.requested_model IS
  'Model selected before execution or fallback.';
COMMENT ON COLUMN addie_thread_messages.model_provider IS
  'Actual provider that produced the assistant response.';
COMMENT ON COLUMN addie_thread_messages.provider_model IS
  'Actual model identity returned by the provider API.';
COMMENT ON COLUMN addie_thread_messages.provider_model_resolution IS
  'How the actual provider/model relates to the requested selection.';
COMMENT ON COLUMN addie_thread_messages.provider_fallback_reason IS
  'Categorical reason actual provider or model differs from the requested selection.';
COMMENT ON COLUMN addie_thread_messages.local_response_reason IS
  'Categorical reason the application produced the response without model attribution.';

-- The legacy interaction audit path is still active for two Slack handlers.
-- Keep its provenance contract aligned until that table is retired.
ALTER TABLE addie_interactions
  ADD COLUMN IF NOT EXISTS model_execution_source VARCHAR(16),
  ADD COLUMN IF NOT EXISTS requested_model_provider VARCHAR(32),
  ADD COLUMN IF NOT EXISTS requested_model VARCHAR(256),
  ADD COLUMN IF NOT EXISTS model_provider VARCHAR(32),
  ADD COLUMN IF NOT EXISTS provider_model VARCHAR(256),
  ADD COLUMN IF NOT EXISTS provider_model_resolution VARCHAR(32),
  ADD COLUMN IF NOT EXISTS provider_fallback_reason VARCHAR(64),
  ADD COLUMN IF NOT EXISTS local_response_reason VARCHAR(64);

ALTER TABLE addie_interactions
  ADD CONSTRAINT addie_interactions_provider_values
    CHECK (
      (requested_model_provider IS NULL OR requested_model_provider IN ('anthropic', 'openai', 'google'))
      AND (model_provider IS NULL OR model_provider IN ('anthropic', 'openai', 'google'))
    ) NOT VALID,
  ADD CONSTRAINT addie_interactions_execution_source_values
    CHECK (model_execution_source IN ('provider', 'local', 'legacy')) NOT VALID,
  ADD CONSTRAINT addie_interactions_provider_model_nonempty
    CHECK (
      (requested_model IS NULL OR length(btrim(requested_model)) BETWEEN 1 AND 256)
      AND (provider_model IS NULL OR length(btrim(provider_model)) BETWEEN 1 AND 256)
    ) NOT VALID,
  ADD CONSTRAINT addie_interactions_provider_fallback_reason_values
    CHECK (
      provider_fallback_reason IS NULL
      OR provider_fallback_reason IN (
        'primary_unavailable',
        'primary_rate_limited',
        'primary_timeout',
        'primary_capability_unsupported',
        'primary_policy_blocked'
      )
    ) NOT VALID,
  ADD CONSTRAINT addie_interactions_provider_model_resolution_values
    CHECK (
      provider_model_resolution IS NULL
      OR provider_model_resolution IN ('exact', 'provider_canonicalized', 'fallback')
    ) NOT VALID,
  ADD CONSTRAINT addie_interactions_local_response_reason_values
    CHECK (
      local_response_reason IS NULL
      OR local_response_reason IN (
        'cost_cap_exceeded',
        'provider_error',
        'stream_interrupted',
        'no_provider_response',
        'canned_response'
      )
    ) NOT VALID,
  ADD CONSTRAINT addie_interactions_provider_execution_atomic
    CHECK (
      (model_execution_source = 'legacy' AND requested_model_provider IS NULL AND requested_model IS NULL AND model_provider IS NULL AND provider_model IS NULL AND provider_model_resolution IS NULL AND provider_fallback_reason IS NULL AND local_response_reason IS NULL)
      OR (model_execution_source = 'provider' AND requested_model_provider IS NOT NULL AND requested_model IS NOT NULL AND model_provider IS NOT NULL AND provider_model IS NOT NULL AND provider_model_resolution IS NOT NULL AND local_response_reason IS NULL)
      OR (model_execution_source = 'local' AND ((requested_model_provider IS NULL AND requested_model IS NULL) OR (requested_model_provider IS NOT NULL AND requested_model IS NOT NULL)) AND model_provider IS NULL AND provider_model IS NULL AND provider_model_resolution IS NULL AND provider_fallback_reason IS NULL AND local_response_reason IS NOT NULL)
    ) NOT VALID,
  ADD CONSTRAINT addie_interactions_provider_fallback_consistent
    CHECK (
      model_execution_source IS DISTINCT FROM 'provider'
      OR (provider_model_resolution = 'exact' AND requested_model_provider = model_provider AND requested_model = provider_model AND provider_fallback_reason IS NULL)
      OR (provider_model_resolution = 'provider_canonicalized' AND requested_model_provider = model_provider AND requested_model <> provider_model AND provider_fallback_reason IS NULL)
      OR (provider_model_resolution = 'fallback' AND (requested_model_provider <> model_provider OR requested_model <> provider_model) AND provider_fallback_reason IS NOT NULL)
    ) NOT VALID;

-- Keep rolling-deploy writes from pre-557 instances compatible here too.

COMMENT ON COLUMN addie_interactions.requested_model_provider IS
  'Provider selected before execution or fallback.';
COMMENT ON COLUMN addie_interactions.requested_model IS
  'Model selected before execution or fallback.';
COMMENT ON COLUMN addie_interactions.model_provider IS
  'Actual provider that produced the interaction output.';
COMMENT ON COLUMN addie_interactions.provider_model IS
  'Actual model identity returned by the provider API.';
COMMENT ON COLUMN addie_interactions.provider_model_resolution IS
  'How the actual provider/model relates to the requested selection.';
COMMENT ON COLUMN addie_interactions.provider_fallback_reason IS
  'Categorical reason actual provider or model differs from the requested selection.';
COMMENT ON COLUMN addie_interactions.local_response_reason IS
  'Categorical reason the application produced the response without model attribution.';
COMMENT ON COLUMN addie_thread_messages.model_execution_source IS
  'provider for model output, local for application output; NULL denotes pre-migration or rolling-deploy writes.';
COMMENT ON COLUMN addie_interactions.model_execution_source IS
  'provider for model output, local for application output; NULL denotes pre-migration or rolling-deploy writes.';
