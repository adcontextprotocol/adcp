-- Aggregate-only, default-off Luna router canary accounting.
-- These tables intentionally contain no channel, user, thread, message,
-- prompt, response, reason text, or per-opportunity hash columns.
CREATE TABLE addie_router_canary_state (
  policy_version VARCHAR(64) NOT NULL,
  pricing_version VARCHAR(64) NOT NULL,
  hash_key_version VARCHAR(64) NOT NULL,
  requested_model VARCHAR(64) NOT NULL,
  sample_bps INTEGER NOT NULL CHECK (sample_bps BETWEEN 1 AND 10000),
  daily_limit SMALLINT NOT NULL CHECK (daily_limit BETWEEN 1 AND 100),
  daily_budget_micros INTEGER NOT NULL CHECK (daily_budget_micros > 0),
  reserved_cost_micros INTEGER NOT NULL CHECK (reserved_cost_micros > 0),
  deadline_ms INTEGER NOT NULL CHECK (deadline_ms BETWEEN 1000 AND 15000),
  inflight_count SMALLINT NOT NULL DEFAULT 0 CHECK (inflight_count BETWEEN 0 AND 100),
  last_admitted_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  rollback_reason VARCHAR(64) CHECK (
    rollback_reason IS NULL OR rollback_reason IN (
      'stale_inflight', 'fallback_safe_default',
      'provider_identity_or_capability', 'failure_rate',
      'average_latency', 'average_cost'
    )
  ),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (policy_version, pricing_version, hash_key_version, requested_model),
  CHECK (length(btrim(policy_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(pricing_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(hash_key_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(requested_model)) BETWEEN 1 AND 64),
  CHECK (daily_limit * reserved_cost_micros <= daily_budget_micros),
  CHECK ((rolled_back_at IS NULL) = (rollback_reason IS NULL)),
  CHECK (last_admitted_at IS NOT NULL OR inflight_count = 0)
);

CREATE TABLE addie_router_canary_daily_metrics (
  metric_date DATE NOT NULL,
  policy_version VARCHAR(64) NOT NULL,
  pricing_version VARCHAR(64) NOT NULL,
  hash_key_version VARCHAR(64) NOT NULL,
  requested_model VARCHAR(64) NOT NULL,
  sampled_count INTEGER NOT NULL DEFAULT 0 CHECK (sampled_count >= 0),
  admitted_count INTEGER NOT NULL DEFAULT 0 CHECK (admitted_count BETWEEN 0 AND 100),
  completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count BETWEEN 0 AND 100),
  quota_rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (quota_rejected_count >= 0),
  rollback_rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rollback_rejected_count >= 0),
  invalid_config_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_config_count >= 0),
  candidate_success_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_success_count >= 0),
  candidate_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_failure_count >= 0),
  fallback_success_count INTEGER NOT NULL DEFAULT 0 CHECK (fallback_success_count >= 0),
  fallback_safe_default_count INTEGER NOT NULL DEFAULT 0 CHECK (fallback_safe_default_count >= 0),
  timeout_count INTEGER NOT NULL DEFAULT 0 CHECK (timeout_count >= 0),
  invalid_output_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_output_count >= 0),
  identity_error_count INTEGER NOT NULL DEFAULT 0 CHECK (identity_error_count >= 0),
  provider_error_count INTEGER NOT NULL DEFAULT 0 CHECK (provider_error_count >= 0),
  candidate_latency_ms_sum BIGINT NOT NULL DEFAULT 0 CHECK (candidate_latency_ms_sum >= 0),
  candidate_latency_ms_max INTEGER NOT NULL DEFAULT 0 CHECK (candidate_latency_ms_max >= 0),
  candidate_cost_micros_sum BIGINT NOT NULL DEFAULT 0 CHECK (candidate_cost_micros_sum >= 0),
  fallback_latency_ms_sum BIGINT NOT NULL DEFAULT 0 CHECK (fallback_latency_ms_sum >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (
    metric_date, policy_version, pricing_version, hash_key_version, requested_model
  ),
  FOREIGN KEY (policy_version, pricing_version, hash_key_version, requested_model)
    REFERENCES addie_router_canary_state (
      policy_version, pricing_version, hash_key_version, requested_model
    ),
  CHECK (length(btrim(policy_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(pricing_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(hash_key_version)) BETWEEN 1 AND 64),
  CHECK (length(btrim(requested_model)) BETWEEN 1 AND 64),
  CHECK (completed_count <= admitted_count),
  CHECK (candidate_success_count + candidate_failure_count = completed_count),
  CHECK (fallback_success_count + fallback_safe_default_count = candidate_failure_count),
  CHECK (timeout_count + invalid_output_count + identity_error_count + provider_error_count
    = candidate_failure_count),
  CHECK (sampled_count >= admitted_count + quota_rejected_count
    + rollback_rejected_count + invalid_config_count)
);

CREATE INDEX idx_addie_router_canary_metrics_date
  ON addie_router_canary_daily_metrics (metric_date);

COMMENT ON TABLE addie_router_canary_state IS
  'Aggregate-only configuration and latched rollback state for the bounded Luna router canary';
COMMENT ON TABLE addie_router_canary_daily_metrics IS
  'Aggregate-only Luna router canary outcomes; contains no production identity, text, or per-opportunity hash';
