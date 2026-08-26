-- Bounded, privacy-safe evidence for the default-off Luna router shadow.
-- Never store message/channel/user/thread identifiers, prompts, responses, or
-- free-form model reasons in this ledger.
CREATE TABLE addie_router_shadow_attempts (
  attempt_id UUID PRIMARY KEY,
  policy_version VARCHAR(64) NOT NULL,
  pricing_version VARCHAR(64) NOT NULL,
  hash_key_version VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL CHECK (
    status IN ('running', 'succeeded', 'invalid', 'error', 'not_dispatched')
  ),
  reason VARCHAR(64) CHECK (
    reason IS NULL OR reason IN (
      'valid_plan',
      'daily_limit_reached',
      'request_too_large',
      'invalid_json',
      'schema_invalid',
      'refusal',
      'truncated',
      'incomplete',
      'empty',
      'timeout_after_dispatch',
      'unexpected_model_identity',
      'invalid_provider_event_stream',
      'unsupported_provider_capability',
      'provider_error',
      'internal_error',
      'stale_interrupted'
    )
  ),
  requested_provider VARCHAR(16) NOT NULL DEFAULT 'openai'
    CHECK (requested_provider = 'openai'),
  requested_model VARCHAR(64) NOT NULL,
  returned_model VARCHAR(256),
  primary_provider VARCHAR(16) NOT NULL CHECK (primary_provider = 'anthropic'),
  primary_pricing_version VARCHAR(64) NOT NULL,
  primary_requested_model VARCHAR(256) NOT NULL,
  primary_returned_model VARCHAR(256),
  primary_status VARCHAR(64) NOT NULL CHECK (
    primary_status IN (
      'valid_plan', 'invalid_json', 'schema_invalid', 'plan_mismatch',
      'refusal', 'truncated', 'incomplete', 'empty', 'missing_dispatch_snapshot',
      'unexpected_model_identity', 'invalid_provider_event_stream',
      'unsupported_provider_capability', 'provider_error'
    )
  ),
  primary_finish_reason VARCHAR(24) CHECK (
    primary_finish_reason IS NULL
    OR primary_finish_reason IN ('stop', 'tool_calls', 'length', 'refusal', 'continue')
  ),
  primary_action VARCHAR(16)
    CHECK (primary_action IS NULL OR primary_action IN ('ignore', 'react', 'respond')),
  shadow_action VARCHAR(16)
    CHECK (shadow_action IS NULL OR shadow_action IN ('ignore', 'react', 'respond')),
  action_match BOOLEAN,
  tool_sets_match BOOLEAN,
  confidence_match BOOLEAN,
  depth_match BOOLEAN,
  emoji_match BOOLEAN,
  privilege_attempt BOOLEAN NOT NULL DEFAULT FALSE,
  invalid_tool_set_attempt BOOLEAN NOT NULL DEFAULT FALSE,
  source_binding_hmac CHAR(64) NOT NULL UNIQUE CHECK (
    source_binding_hmac ~ '^[0-9a-f]{64}$'
  ),
  canonical_request_hmac CHAR(64) NOT NULL CHECK (
    canonical_request_hmac ~ '^[0-9a-f]{64}$'
  ),
  primary_provider_request_hmac CHAR(64) CHECK (
    primary_provider_request_hmac IS NULL
    OR primary_provider_request_hmac ~ '^[0-9a-f]{64}$'
  ),
  primary_output_hmac CHAR(64) CHECK (
    primary_output_hmac IS NULL OR primary_output_hmac ~ '^[0-9a-f]{64}$'
  ),
  provider_request_hmac CHAR(64) CHECK (
    provider_request_hmac IS NULL OR provider_request_hmac ~ '^[0-9a-f]{64}$'
  ),
  provider_output_hmac CHAR(64) CHECK (
    provider_output_hmac IS NULL OR provider_output_hmac ~ '^[0-9a-f]{64}$'
  ),
  completion_hmac CHAR(64) CHECK (
    completion_hmac IS NULL OR completion_hmac ~ '^[0-9a-f]{64}$'
  ),
  primary_input_tokens INTEGER CHECK (
    primary_input_tokens IS NULL OR primary_input_tokens >= 0
  ),
  primary_output_tokens INTEGER CHECK (
    primary_output_tokens IS NULL OR primary_output_tokens >= 0
  ),
  primary_cache_read_tokens INTEGER CHECK (
    primary_cache_read_tokens IS NULL OR primary_cache_read_tokens >= 0
  ),
  primary_cache_write_tokens INTEGER CHECK (
    primary_cache_write_tokens IS NULL OR primary_cache_write_tokens >= 0
  ),
  primary_latency_ms INTEGER NOT NULL CHECK (primary_latency_ms >= 0),
  primary_estimated_cost_micros INTEGER CHECK (
    primary_estimated_cost_micros IS NULL OR primary_estimated_cost_micros >= 0
  ),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  shadow_latency_ms INTEGER CHECK (shadow_latency_ms IS NULL OR shadow_latency_ms >= 0),
  reserved_cost_micros INTEGER NOT NULL CHECK (reserved_cost_micros > 0),
  estimated_cost_micros INTEGER CHECK (
    estimated_cost_micros IS NULL OR estimated_cost_micros >= 0
  ),
  selected_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  retained_until TIMESTAMPTZ NOT NULL,
  quota_date DATE NOT NULL,
  quota_slot SMALLINT NOT NULL CHECK (quota_slot BETWEEN 1 AND 100),
  CHECK (length(btrim(policy_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(pricing_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(primary_pricing_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(hash_key_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(requested_model)) BETWEEN 1 AND 64),
  CHECK (returned_model IS NULL OR length(btrim(returned_model)) BETWEEN 1 AND 256),
  CHECK (length(btrim(primary_requested_model)) BETWEEN 1 AND 256),
  CHECK (primary_returned_model IS NULL OR length(btrim(primary_returned_model)) BETWEEN 1 AND 256),
  CHECK (retained_until > selected_at),
  CHECK (dispatched_at IS NULL OR provider_request_hmac IS NOT NULL),
  CHECK (status = 'running' OR completed_at IS NOT NULL),
  CHECK (status <> 'running' OR reason IS NULL),
  CHECK (status = 'running' OR reason = 'stale_interrupted' OR completion_hmac IS NOT NULL),
  CHECK (status <> 'succeeded' OR (reason = 'valid_plan' AND shadow_action IS NOT NULL)),
  CHECK (status <> 'not_dispatched' OR dispatched_at IS NULL),
  UNIQUE (quota_date, quota_slot),
  CHECK (
    status NOT IN ('succeeded', 'invalid')
    OR (dispatched_at IS NOT NULL AND provider_request_hmac IS NOT NULL)
  ),
  CHECK (
    status <> 'succeeded'
    OR (
      returned_model IS NOT NULL AND provider_output_hmac IS NOT NULL
      AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
    )
  ),
  CHECK (
    primary_status <> 'valid_plan'
    OR (
      primary_action IS NOT NULL AND primary_returned_model IS NOT NULL
      AND primary_provider_request_hmac IS NOT NULL
      AND primary_output_hmac IS NOT NULL
      AND primary_input_tokens IS NOT NULL AND primary_output_tokens IS NOT NULL
    )
  )
);

-- Bounded aggregate denominator for every sampled observer invocation,
-- including duplicate delivery and quota exhaustion. No source identity is
-- retained when an invocation does not win a paid-call slot.
CREATE TABLE addie_router_shadow_daily_admissions (
  admission_date DATE NOT NULL,
  policy_version VARCHAR(64) NOT NULL,
  pricing_version VARCHAR(64) NOT NULL,
  primary_pricing_version VARCHAR(64) NOT NULL,
  hash_key_version VARCHAR(64) NOT NULL,
  requested_model VARCHAR(64) NOT NULL,
  primary_requested_model VARCHAR(256) NOT NULL,
  sampled_count BIGINT NOT NULL DEFAULT 0 CHECK (sampled_count >= 0),
  claimed_count BIGINT NOT NULL DEFAULT 0 CHECK (claimed_count >= 0),
  duplicate_count BIGINT NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  quota_exhausted_count BIGINT NOT NULL DEFAULT 0 CHECK (quota_exhausted_count >= 0),
  retained_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (
    admission_date, policy_version, pricing_version, primary_pricing_version,
    hash_key_version, requested_model, primary_requested_model
  ),
  CHECK (length(btrim(policy_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(pricing_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(primary_pricing_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(hash_key_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(requested_model)) BETWEEN 1 AND 64),
  CHECK (length(btrim(primary_requested_model)) BETWEEN 1 AND 256),
  CHECK (sampled_count >= claimed_count + duplicate_count + quota_exhausted_count)
);

CREATE INDEX idx_addie_router_shadow_attempts_selected
  ON addie_router_shadow_attempts (selected_at, status);
CREATE INDEX idx_addie_router_shadow_attempts_retention
  ON addie_router_shadow_attempts (retained_until);
CREATE INDEX idx_addie_router_shadow_admissions_retention
  ON addie_router_shadow_daily_admissions (retained_until);

COMMENT ON TABLE addie_router_shadow_attempts IS
  'Hash-only, categorical evidence for sampled Luna router shadow calls; contains no production text or identifiers';
COMMENT ON COLUMN addie_router_shadow_attempts.provider_request_hmac IS
  'Domain-separated HMAC of the exact frozen provider request immediately before dispatch';
COMMENT ON COLUMN addie_router_shadow_attempts.provider_output_hmac IS
  'Domain-separated HMAC of normalized provider output held only in memory';
COMMENT ON COLUMN addie_router_shadow_attempts.canonical_request_hmac IS
  'HMAC of the exact frozen provider-neutral request passed to the primary adapter';
COMMENT ON COLUMN addie_router_shadow_attempts.primary_provider_request_hmac IS
  'HMAC of the exact frozen primary provider envelope captured immediately before dispatch';
COMMENT ON TABLE addie_router_shadow_daily_admissions IS
  'Bounded categorical counts for sampled router-shadow invocations; contains no production identity or text';
