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
  pricing_cohort_digest VARCHAR(71) NOT NULL CHECK (pricing_cohort_digest ~ '^sha256:[a-f0-9]{64}$'),
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
  actual_cost_microdollars BIGINT CHECK (actual_cost_microdollars IS NULL OR actual_cost_microdollars BETWEEN 0 AND 5000000),
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

-- Check constraints cannot inspect array elements or sibling plan rows. These
-- deferred constraints make direct SQL writes obey the same fixed plan that
-- the ledger derives: 168 assignments, 126 dispatch dispositions, 192 slots,
-- and only positive per-slot reservations totaling 2,819,484 micros.
CREATE FUNCTION addie_fixed_trace_component_smoke_check_plan() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  plan_count INTEGER;
  dispatch_count INTEGER;
  slots INTEGER;
  reserved BIGINT;
  invalid_reservation BOOLEAN;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE disposition = 'provider_dispatch'),
         COALESCE(sum(maximum_provider_invocations), 0),
         COALESCE(sum((SELECT sum(value) FROM unnest(reserved_microdollars) AS value)), 0),
         COALESCE(bool_or(EXISTS (SELECT 1 FROM unnest(reserved_microdollars) AS value WHERE value <= 0 OR value > 2819484)), false)
    INTO plan_count, dispatch_count, slots, reserved, invalid_reservation
    FROM addie_fixed_trace_component_smoke_run_plan
   WHERE authorization_digest = NEW.authorization_digest;
  IF plan_count <> 168 OR dispatch_count <> 126 OR slots <> 192 OR reserved <> 2819484 OR invalid_reservation THEN
    RAISE EXCEPTION 'fixed-trace component smoke plan is not the admitted exact plan';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER addie_fixed_trace_component_smoke_plan_exact
AFTER INSERT OR UPDATE OR DELETE ON addie_fixed_trace_component_smoke_run_plan
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION addie_fixed_trace_component_smoke_check_plan();

CREATE FUNCTION addie_fixed_trace_component_smoke_check_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  max_invocations SMALLINT;
  disposition VARCHAR(24);
  reserved BIGINT;
  prior_spend BIGINT;
  reservation_limit BIGINT;
  provider_limit BIGINT;
BEGIN
  SELECT maximum_provider_invocations, disposition, reserved_microdollars[NEW.invocation_ordinal]
    INTO max_invocations, disposition, reserved
    FROM addie_fixed_trace_component_smoke_run_plan
   WHERE authorization_digest = NEW.authorization_digest AND assignment_id = NEW.assignment_id;
  IF disposition IS DISTINCT FROM 'provider_dispatch' OR NEW.invocation_ordinal > max_invocations THEN
    RAISE EXCEPTION 'attempt is not an admitted provider-dispatch ordinal';
  END IF;
  IF NEW.actual_cost_microdollars IS NOT NULL AND NEW.actual_cost_microdollars > reserved THEN
    RAISE EXCEPTION 'attempt cost exceeds its ordinal reservation';
  END IF;
  SELECT reservation_microdollars, provider_ceiling_microdollars INTO reservation_limit, provider_limit
    FROM addie_fixed_trace_component_smoke_authorizations WHERE authorization_digest = NEW.authorization_digest;
  SELECT COALESCE(sum(actual_cost_microdollars), 0) INTO prior_spend
    FROM addie_fixed_trace_component_smoke_attempts
   WHERE authorization_digest = NEW.authorization_digest AND attempt_id <> NEW.attempt_id;
  IF prior_spend + COALESCE(NEW.actual_cost_microdollars, 0) > reservation_limit
     OR prior_spend + COALESCE(NEW.actual_cost_microdollars, 0) > provider_limit THEN
    RAISE EXCEPTION 'attempt cost exceeds fixed-trace aggregate limit';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER addie_fixed_trace_component_smoke_attempt_exact
BEFORE INSERT OR UPDATE OF invocation_ordinal, actual_cost_microdollars ON addie_fixed_trace_component_smoke_attempts
FOR EACH ROW EXECUTE FUNCTION addie_fixed_trace_component_smoke_check_attempt();

COMMENT ON TABLE addie_fixed_trace_component_smoke_authorizations IS
  'One-use signed private smoke grants, stored only as digests and categorical consumption state; no bearer data or text';
COMMENT ON TABLE addie_fixed_trace_component_smoke_run_plan IS
  'Exact admitted 168-entry private smoke plan, persisted before any future provider dispatch';
COMMENT ON TABLE addie_fixed_trace_component_smoke_attempts IS
  'Intent-before-terminal, HMAC-only provider attempt evidence; unknown exposure must halt the authorization';
