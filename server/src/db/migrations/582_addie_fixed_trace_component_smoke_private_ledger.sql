-- Private fixed-trace smoke authorization boundary.  This schema is additive
-- and deliberately contains only digests, categorical state, and bounded
-- usage metadata: never a bearer grant, nonce, prompt, output, provider error,
-- tool payload, credential, or human approval text.

CREATE TABLE addie_fixed_trace_component_smoke_authorizations (
  authorization_digest CHAR(64) PRIMARY KEY CHECK (authorization_digest ~ '^[a-f0-9]{64}$'),
  signed_payload_digest CHAR(64) NOT NULL UNIQUE CHECK (signed_payload_digest ~ '^[a-f0-9]{64}$'),
  signature BYTEA NOT NULL CHECK (octet_length(signature) = 64),
  kid VARCHAR(64) NOT NULL CHECK (kid ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  nonce_commitment CHAR(64) NOT NULL UNIQUE CHECK (nonce_commitment ~ '^[a-f0-9]{64}$'),
  grant_version VARCHAR(96) NOT NULL CHECK (grant_version = 'addie-fixed-trace-component-smoke-signed-grant-v1'),
  stage_id VARCHAR(32) NOT NULL CHECK (stage_id = 'stage_1_smoke'),
  admission_version VARCHAR(96) NOT NULL CHECK (admission_version = 'addie-fixed-trace-component-smoke-admission-v2'),
  aggregate_admission_fingerprint CHAR(64) NOT NULL CHECK (aggregate_admission_fingerprint = '731930c18475672a0ec6b44c9ff91fa89d30c441e34af32b536a28258271077d'),
  probes SMALLINT NOT NULL CHECK (probes = 8),
  router_cells SMALLINT NOT NULL CHECK (router_cells = 10),
  generation_cells SMALLINT NOT NULL CHECK (generation_cells = 11),
  total_cells SMALLINT NOT NULL CHECK (total_cells = 21),
  repetitions SMALLINT NOT NULL CHECK (repetitions = 1),
  assignments SMALLINT NOT NULL CHECK (assignments = 168),
  provider_dispatch_assignments SMALLINT NOT NULL CHECK (provider_dispatch_assignments = 126),
  local_terminal_assignments SMALLINT NOT NULL CHECK (local_terminal_assignments = 21),
  pre_dispatch_fault_assignments SMALLINT NOT NULL CHECK (pre_dispatch_fault_assignments = 21),
  maximum_planned_invocation_slots SMALLINT NOT NULL CHECK (maximum_planned_invocation_slots = 256),
  maximum_provider_invocations SMALLINT NOT NULL CHECK (maximum_provider_invocations = 192),
  reservation_microdollars BIGINT NOT NULL CHECK (reservation_microdollars = 2819484),
  provider_ceiling_microdollars BIGINT NOT NULL CHECK (provider_ceiling_microdollars = 5000000),
  pricing_cohort_digest CHAR(64) NOT NULL CHECK (pricing_cohort_digest ~ '^[a-f0-9]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(32) NOT NULL CHECK (status IN ('consumed', 'halted', 'unknown_exposure')),
  consumed_at TIMESTAMPTZ NOT NULL,
  unknown_exposure_at TIMESTAMPTZ,
  reservation_id VARCHAR(44) NOT NULL UNIQUE CHECK (reservation_id ~ '^reservation_[a-f0-9]{32}$'),
  CHECK (issued_at < expires_at),
  CHECK (status = 'unknown_exposure' OR unknown_exposure_at IS NULL),
  CHECK (status <> 'unknown_exposure' OR unknown_exposure_at IS NOT NULL)
);

CREATE TABLE addie_fixed_trace_component_smoke_run_plan (
  authorization_digest CHAR(64) NOT NULL REFERENCES addie_fixed_trace_component_smoke_authorizations(authorization_digest) ON DELETE RESTRICT,
  assignment_id CHAR(64) NOT NULL CHECK (assignment_id ~ '^[a-f0-9]{64}$'),
  probe_id VARCHAR(128) NOT NULL CHECK (length(probe_id) BETWEEN 1 AND 128),
  cell_id VARCHAR(128) NOT NULL CHECK (length(cell_id) BETWEEN 1 AND 128),
  disposition VARCHAR(24) NOT NULL CHECK (disposition IN ('provider_dispatch', 'local_terminal', 'pre_dispatch_fault')),
  maximum_provider_invocations SMALLINT NOT NULL CHECK (maximum_provider_invocations BETWEEN 0 AND 2),
  requested_provider VARCHAR(32) NOT NULL CHECK (length(requested_provider) BETWEEN 1 AND 32),
  requested_model VARCHAR(128) NOT NULL CHECK (length(requested_model) BETWEEN 1 AND 128),
  requested_effort VARCHAR(64) NOT NULL CHECK (length(requested_effort) BETWEEN 1 AND 64),
  pricing_profile_id VARCHAR(128) NOT NULL CHECK (length(pricing_profile_id) BETWEEN 1 AND 128),
  max_input_tokens INTEGER NOT NULL CHECK (max_input_tokens > 0 AND max_input_tokens <= 1000000),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0 AND max_output_tokens <= 1000000),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0 AND timeout_ms <= 86400000),
  retries SMALLINT NOT NULL CHECK (retries = 0),
  reserved_microdollars BIGINT[] NOT NULL CHECK (cardinality(reserved_microdollars) = maximum_provider_invocations),
  non_dispatch_status VARCHAR(24) CHECK (non_dispatch_status IS NULL OR non_dispatch_status IN ('local_terminal', 'pre_dispatch_fault')),
  non_dispatch_terminal_at TIMESTAMPTZ,
  PRIMARY KEY (authorization_digest, assignment_id),
  UNIQUE (authorization_digest, probe_id, cell_id),
  CHECK ((disposition = 'provider_dispatch' AND maximum_provider_invocations > 0) OR (disposition <> 'provider_dispatch' AND maximum_provider_invocations = 0)),
  CHECK (array_position(reserved_microdollars, NULL) IS NULL),
  CHECK (non_dispatch_status IS NULL OR non_dispatch_status = disposition),
  CHECK ((non_dispatch_status IS NULL) = (non_dispatch_terminal_at IS NULL))
);

CREATE TABLE addie_fixed_trace_component_smoke_attempts (
  attempt_id VARCHAR(40) PRIMARY KEY CHECK (attempt_id ~ '^attempt_[a-f0-9]{32}$'),
  authorization_digest CHAR(64) NOT NULL,
  assignment_id CHAR(64) NOT NULL,
  invocation_ordinal SMALLINT NOT NULL CHECK (invocation_ordinal BETWEEN 1 AND 2),
  status VARCHAR(32) NOT NULL CHECK (status IN ('intent_recorded', 'succeeded', 'provider_failed', 'timeout_after_dispatch', 'malformed_response', 'identity_mismatch', 'missing_usage')),
  prepared_request_hmac CHAR(64) NOT NULL CHECK (prepared_request_hmac ~ '^[a-f0-9]{64}$'),
  response_hmac CHAR(64) CHECK (response_hmac IS NULL OR response_hmac ~ '^[a-f0-9]{64}$'),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  actual_cost_microdollars BIGINT CHECK (actual_cost_microdollars IS NULL OR actual_cost_microdollars BETWEEN 0 AND 2819484),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 86400000),
  intent_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  terminal_at TIMESTAMPTZ,
  FOREIGN KEY (authorization_digest, assignment_id) REFERENCES addie_fixed_trace_component_smoke_run_plan(authorization_digest, assignment_id) ON DELETE RESTRICT,
  UNIQUE (authorization_digest, assignment_id, invocation_ordinal),
  CHECK ((status = 'intent_recorded') = (terminal_at IS NULL)),
  CHECK (status <> 'succeeded' OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND actual_cost_microdollars IS NOT NULL AND latency_ms IS NOT NULL AND response_hmac IS NOT NULL)),
  CHECK (status NOT IN ('malformed_response', 'identity_mismatch', 'missing_usage') OR (input_tokens IS NULL AND output_tokens IS NULL AND actual_cost_microdollars IS NULL))
);

CREATE INDEX addie_fixed_trace_component_smoke_attempts_open_idx
  ON addie_fixed_trace_component_smoke_attempts (authorization_digest, status)
  WHERE status = 'intent_recorded';

COMMENT ON TABLE addie_fixed_trace_component_smoke_authorizations IS
  'One-use signed private smoke grants, stored only as digests and categorical consumption state; no bearer data or text';
COMMENT ON TABLE addie_fixed_trace_component_smoke_run_plan IS
  'Exact admitted 168-entry private smoke plan, persisted before any future provider dispatch';
COMMENT ON TABLE addie_fixed_trace_component_smoke_attempts IS
  'Intent-before-terminal, HMAC-only provider attempt evidence; unknown exposure must halt the authorization';
