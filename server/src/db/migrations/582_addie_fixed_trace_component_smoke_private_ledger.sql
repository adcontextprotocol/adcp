-- Private fixed-trace smoke authorization boundary.  This schema is additive
-- and deliberately contains only digests, categorical state, and bounded
-- usage metadata: never a bearer grant, nonce, prompt, output, provider error,
-- tool payload, credential, or human approval text.

CREATE TABLE addie_fixed_trace_component_smoke_authorizations (
  authorization_digest CHAR(64) PRIMARY KEY CHECK (authorization_digest ~ '^[a-f0-9]{64}$'),
  signed_payload_digest CHAR(64) NOT NULL UNIQUE CHECK (signed_payload_digest ~ '^[a-f0-9]{64}$'),
  signature_digest CHAR(64) NOT NULL CHECK (signature_digest ~ '^[a-f0-9]{64}$'),
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
  status VARCHAR(32) NOT NULL CHECK (status IN ('consumed', 'completed', 'halted', 'unknown_exposure')),
  consumed_at TIMESTAMPTZ NOT NULL,
  unknown_exposure_at TIMESTAMPTZ,
  reservation_id VARCHAR(44) NOT NULL UNIQUE CHECK (reservation_id ~ '^reservation_[a-f0-9]{32}$'),
  CHECK (issued_at < expires_at),
  CHECK (expires_at - issued_at <= interval '15 minutes'),
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
  -- Assignment outcomes close the 168-entry denominator. They are distinct
  -- from provider attempt terminals and contain no provider-call evidence.
  assignment_outcome VARCHAR(32) CHECK (assignment_outcome IS NULL OR assignment_outcome IN ('provider_completed', 'provider_failed', 'provider_unknown_exposure', 'local_terminal', 'pre_dispatch_fault', 'not_executed_after_halt')),
  assignment_terminal_at TIMESTAMPTZ,
  assignment_final_invocation_ordinal SMALLINT,
  PRIMARY KEY (authorization_digest, assignment_id),
  UNIQUE (authorization_digest, probe_id, cell_id),
  CHECK ((disposition = 'provider_dispatch' AND maximum_provider_invocations > 0) OR (disposition <> 'provider_dispatch' AND maximum_provider_invocations = 0)),
  CHECK (array_position(reserved_microdollars, NULL) IS NULL),
  CHECK (assignment_outcome IS NULL OR assignment_outcome = disposition OR assignment_outcome IN ('provider_completed', 'provider_failed', 'provider_unknown_exposure', 'not_executed_after_halt')),
  CHECK ((assignment_outcome IS NULL) = (assignment_terminal_at IS NULL)),
  CHECK ((assignment_outcome IN ('provider_completed', 'provider_failed', 'provider_unknown_exposure')) = (assignment_final_invocation_ordinal IS NOT NULL)),
  CHECK (assignment_final_invocation_ordinal IS NULL OR assignment_final_invocation_ordinal BETWEEN 1 AND maximum_provider_invocations)
);

CREATE TABLE addie_fixed_trace_component_smoke_attempts (
  attempt_id VARCHAR(40) PRIMARY KEY CHECK (attempt_id ~ '^attempt_[a-f0-9]{32}$'),
  authorization_digest CHAR(64) NOT NULL,
  assignment_id CHAR(64) NOT NULL,
  invocation_ordinal SMALLINT NOT NULL CHECK (invocation_ordinal BETWEEN 1 AND 2),
  status VARCHAR(32) NOT NULL CHECK (status IN ('intent_recorded', 'succeeded', 'provider_failed', 'timeout_after_dispatch', 'malformed_response', 'identity_mismatch', 'missing_usage', 'invalid_limits', 'pricing_unavailable', 'unknown_exposure')),
  response_disposition VARCHAR(32) CHECK (response_disposition IS NULL OR response_disposition IN ('final_response', 'tool_continuation_required')),
  prepared_request_hmac CHAR(64) NOT NULL CHECK (prepared_request_hmac ~ '^[a-f0-9]{64}$'),
  response_hmac CHAR(64) CHECK (response_hmac IS NULL OR response_hmac ~ '^[a-f0-9]{64}$'),
  returned_provider VARCHAR(32) CHECK (returned_provider IS NULL OR length(returned_provider) BETWEEN 1 AND 32),
  returned_model VARCHAR(128) CHECK (returned_model IS NULL OR length(returned_model) BETWEEN 1 AND 128),
  returned_effort VARCHAR(64) CHECK (returned_effort IS NULL OR length(returned_effort) BETWEEN 1 AND 64),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  -- `actual` is a settled, admitted charge. `observed` retains a complete,
  -- independently priceable receipt even when a limit violation halts it.
  actual_cost_microdollars BIGINT CHECK (actual_cost_microdollars IS NULL OR actual_cost_microdollars BETWEEN 0 AND 5000000),
  observed_cost_microdollars BIGINT CHECK (observed_cost_microdollars IS NULL OR observed_cost_microdollars BETWEEN 0 AND 100000000),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 86400000),
  intent_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  terminal_at TIMESTAMPTZ,
  FOREIGN KEY (authorization_digest, assignment_id) REFERENCES addie_fixed_trace_component_smoke_run_plan(authorization_digest, assignment_id) ON DELETE RESTRICT,
  UNIQUE (authorization_digest, assignment_id, invocation_ordinal),
  CHECK ((status = 'intent_recorded') = (terminal_at IS NULL)),
  CHECK ((returned_provider IS NULL) = (returned_model IS NULL) AND (returned_provider IS NULL) = (returned_effort IS NULL)),
  CHECK (actual_cost_microdollars IS NULL OR status IN ('succeeded', 'provider_failed')),
  CHECK (observed_cost_microdollars IS NULL OR status = 'invalid_limits'),
  CHECK (actual_cost_microdollars IS NULL OR observed_cost_microdollars IS NULL),
  CHECK (status <> 'intent_recorded' OR (response_disposition IS NULL AND response_hmac IS NULL AND returned_provider IS NULL AND input_tokens IS NULL AND output_tokens IS NULL AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL AND actual_cost_microdollars IS NULL AND observed_cost_microdollars IS NULL AND latency_ms IS NULL)),
  CHECK (status NOT IN ('succeeded', 'provider_failed') OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND cache_read_tokens IS NOT NULL AND cache_write_tokens IS NOT NULL AND actual_cost_microdollars IS NOT NULL AND observed_cost_microdollars IS NULL AND latency_ms IS NOT NULL AND response_hmac IS NOT NULL AND returned_provider IS NOT NULL)),
  CHECK ((status = 'succeeded') = (response_disposition IS NOT NULL)),
  CHECK (status NOT IN ('malformed_response', 'missing_usage') OR (input_tokens IS NULL AND output_tokens IS NULL AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL AND actual_cost_microdollars IS NULL AND observed_cost_microdollars IS NULL AND latency_ms IS NULL)),
  CHECK (status <> 'malformed_response' OR returned_provider IS NULL),
  CHECK (status <> 'missing_usage' OR returned_provider IS NOT NULL),
  CHECK (status <> 'identity_mismatch' OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND cache_read_tokens IS NOT NULL AND cache_write_tokens IS NOT NULL AND actual_cost_microdollars IS NULL AND observed_cost_microdollars IS NULL AND latency_ms IS NOT NULL AND response_hmac IS NOT NULL AND returned_provider IS NOT NULL)),
  CHECK (status <> 'invalid_limits' OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND cache_read_tokens IS NOT NULL AND cache_write_tokens IS NOT NULL AND actual_cost_microdollars IS NULL AND observed_cost_microdollars IS NOT NULL AND latency_ms IS NOT NULL AND response_hmac IS NOT NULL AND returned_provider IS NOT NULL)),
  CHECK (status <> 'timeout_after_dispatch' OR (response_hmac IS NULL AND returned_provider IS NULL AND input_tokens IS NULL AND output_tokens IS NULL AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL AND actual_cost_microdollars IS NULL AND observed_cost_microdollars IS NULL AND latency_ms IS NULL)),
  CHECK (status <> 'unknown_exposure' OR (response_hmac IS NULL AND returned_provider IS NULL AND input_tokens IS NULL AND output_tokens IS NULL AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL AND actual_cost_microdollars IS NULL AND observed_cost_microdollars IS NULL AND latency_ms IS NULL)),
  CHECK (status NOT IN ('succeeded', 'provider_failed', 'malformed_response', 'identity_mismatch', 'missing_usage') OR response_hmac IS NOT NULL)
);

CREATE INDEX addie_fixed_trace_component_smoke_attempts_open_idx
  ON addie_fixed_trace_component_smoke_attempts (authorization_digest, status)
  WHERE status = 'intent_recorded';

-- The fixed manifest is pinned as a domain-separated SHA-256 over every
-- persisted authority field (including the deterministic assignment identity).
-- This makes a complete, initially inserted direct-SQL plan subject to the
-- same exact 8 x 21 authority as the TypeScript derivation, not merely the
-- same aggregate counts. pgcrypto is installed by an earlier migration.
CREATE FUNCTION addie_fixed_trace_component_smoke_plan_manifest_digest(p_authorization_digest CHAR(64)) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT encode(digest(E'adcp:addie:fixed-trace-component-smoke:db-plan-manifest:v1\n' || COALESCE(string_agg(
    concat_ws('|', assignment_id, probe_id, cell_id, disposition,
      maximum_provider_invocations::text, requested_provider, requested_model,
      requested_effort, pricing_profile_id, max_input_tokens::text,
      max_output_tokens::text, timeout_ms::text, retries::text,
      array_to_string(reserved_microdollars, ',')), E'\n' ORDER BY assignment_id), ''), 'sha256'), 'hex')
    FROM addie_fixed_trace_component_smoke_run_plan
   WHERE authorization_digest = p_authorization_digest;
$$;

-- Check constraints cannot inspect array elements or sibling plan rows. These
-- deferred constraints bind all 168 rows to the admitted exact manifest,
-- including disposition, cell identity/provider/model/effort/profile/limits,
-- ordinals and reservations, in addition to the aggregate invariants.
CREATE FUNCTION addie_fixed_trace_component_smoke_check_plan_group(p_authorization_digest CHAR(64)) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  plan_count INTEGER;
  dispatch_count INTEGER;
  local_count INTEGER;
  pre_dispatch_count INTEGER;
  slots INTEGER;
  reserved BIGINT;
  invalid_reservation BOOLEAN;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE disposition = 'provider_dispatch'),
         count(*) FILTER (WHERE disposition = 'local_terminal'), count(*) FILTER (WHERE disposition = 'pre_dispatch_fault'),
         COALESCE(sum(maximum_provider_invocations), 0),
         COALESCE(sum((SELECT sum(value) FROM unnest(reserved_microdollars) AS value)), 0),
         COALESCE(bool_or(EXISTS (SELECT 1 FROM unnest(reserved_microdollars) AS value WHERE value <= 0 OR value > 2819484)), false)
   INTO plan_count, dispatch_count, local_count, pre_dispatch_count, slots, reserved, invalid_reservation
    FROM addie_fixed_trace_component_smoke_run_plan
   WHERE authorization_digest = p_authorization_digest;
  IF plan_count <> 168 OR dispatch_count <> 126 OR local_count <> 21 OR pre_dispatch_count <> 21 OR slots <> 192 OR reserved <> 2819484 OR invalid_reservation
     OR addie_fixed_trace_component_smoke_plan_manifest_digest(p_authorization_digest) <> '89fbd437f1f7f39ed04874949c86564a0f70dacb034936341c374f74c5d7d63b' THEN
    RAISE EXCEPTION 'fixed-trace component smoke plan is not the admitted exact plan';
  END IF;
END;
$$;

CREATE FUNCTION addie_fixed_trace_component_smoke_check_plan() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM addie_fixed_trace_component_smoke_check_plan_group(COALESCE(NEW.authorization_digest, OLD.authorization_digest));
  IF TG_OP = 'UPDATE' AND OLD.authorization_digest IS DISTINCT FROM NEW.authorization_digest THEN
    PERFORM addie_fixed_trace_component_smoke_check_plan_group(OLD.authorization_digest);
  END IF;
  RETURN NULL;
END;
$$;

-- Plan identity and limits are immutable after reservation.  Completing a
-- non-dispatch row is the only permitted plan mutation.
CREATE FUNCTION addie_fixed_trace_component_smoke_protect_plan() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  terminal_count INTEGER;
  open_attempt BOOLEAN;
  failed_attempt BOOLEAN;
  authorization_status VARCHAR(32);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admitted plan rows are immutable';
  END IF;
  IF NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.probe_id IS DISTINCT FROM OLD.probe_id OR NEW.cell_id IS DISTINCT FROM OLD.cell_id
     OR NEW.disposition IS DISTINCT FROM OLD.disposition OR NEW.maximum_provider_invocations IS DISTINCT FROM OLD.maximum_provider_invocations
     OR NEW.requested_provider IS DISTINCT FROM OLD.requested_provider OR NEW.requested_model IS DISTINCT FROM OLD.requested_model
     OR NEW.requested_effort IS DISTINCT FROM OLD.requested_effort OR NEW.pricing_profile_id IS DISTINCT FROM OLD.pricing_profile_id
     OR NEW.max_input_tokens IS DISTINCT FROM OLD.max_input_tokens OR NEW.max_output_tokens IS DISTINCT FROM OLD.max_output_tokens
     OR NEW.timeout_ms IS DISTINCT FROM OLD.timeout_ms OR NEW.retries IS DISTINCT FROM OLD.retries
     OR NEW.reserved_microdollars IS DISTINCT FROM OLD.reserved_microdollars THEN
    RAISE EXCEPTION 'admitted plan fields are immutable';
  END IF;
  IF OLD.assignment_outcome IS NOT NULL OR NEW.assignment_outcome IS NULL OR NEW.assignment_terminal_at IS NULL
     OR (NEW.assignment_outcome <> OLD.disposition AND NEW.assignment_outcome NOT IN ('provider_completed', 'provider_failed', 'provider_unknown_exposure', 'not_executed_after_halt')) THEN
    RAISE EXCEPTION 'assignment outcome is monotonic';
  END IF;
  IF NEW.assignment_outcome IN ('provider_completed', 'provider_failed', 'provider_unknown_exposure') AND OLD.disposition <> 'provider_dispatch' THEN
    RAISE EXCEPTION 'provider assignment outcome requires provider dispatch';
  END IF;
  -- Every assignment outcome serializes on this authorization row.  This
  -- makes the last-two-outcomes completion transition race-safe.
  SELECT status INTO authorization_status FROM addie_fixed_trace_component_smoke_authorizations
   WHERE authorization_digest = NEW.authorization_digest FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'assignment authorization is absent'; END IF;
  IF NEW.assignment_outcome IN ('provider_completed', 'provider_failed', 'provider_unknown_exposure') THEN
    SELECT count(*), bool_or(status = 'intent_recorded'), bool_or(status <> 'succeeded')
      INTO terminal_count, open_attempt, failed_attempt
      FROM addie_fixed_trace_component_smoke_attempts
     WHERE authorization_digest = NEW.authorization_digest AND assignment_id = NEW.assignment_id
       AND invocation_ordinal <= NEW.assignment_final_invocation_ordinal;
    IF terminal_count <> NEW.assignment_final_invocation_ordinal OR COALESCE(open_attempt, false)
       OR (NEW.assignment_outcome = 'provider_completed' AND (COALESCE(failed_attempt, false) OR authorization_status = 'completed'
           OR NOT EXISTS (SELECT 1 FROM addie_fixed_trace_component_smoke_attempts WHERE authorization_digest = NEW.authorization_digest
                            AND assignment_id = NEW.assignment_id AND invocation_ordinal = NEW.assignment_final_invocation_ordinal
                            AND status = 'succeeded' AND response_disposition = 'final_response')))
       OR (NEW.assignment_outcome = 'provider_failed' AND NOT COALESCE(failed_attempt, false))
       OR (NEW.assignment_outcome = 'provider_unknown_exposure' AND (authorization_status <> 'unknown_exposure'
           OR NOT EXISTS (SELECT 1 FROM addie_fixed_trace_component_smoke_attempts WHERE authorization_digest = NEW.authorization_digest
                            AND assignment_id = NEW.assignment_id AND invocation_ordinal = NEW.assignment_final_invocation_ordinal
                            AND status = 'unknown_exposure'))) THEN
      RAISE EXCEPTION 'provider assignment outcome lacks final terminal attempt evidence';
    END IF;
  END IF;
  IF NEW.assignment_outcome = 'not_executed_after_halt' THEN
    PERFORM 1 FROM addie_fixed_trace_component_smoke_authorizations
     WHERE authorization_digest = NEW.authorization_digest AND status IN ('halted', 'unknown_exposure') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'omission requires permanent halt'; END IF;
    PERFORM 1 FROM addie_fixed_trace_component_smoke_attempts
     WHERE authorization_digest = NEW.authorization_digest AND assignment_id = NEW.assignment_id;
    IF FOUND THEN RAISE EXCEPTION 'omission requires an unstarted assignment'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER addie_fixed_trace_component_smoke_plan_immutable
BEFORE UPDATE OR DELETE ON addie_fixed_trace_component_smoke_run_plan
FOR EACH ROW EXECUTE FUNCTION addie_fixed_trace_component_smoke_protect_plan();

CREATE FUNCTION addie_fixed_trace_component_smoke_complete_assignment_denominator() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assignment_outcome IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM addie_fixed_trace_component_smoke_run_plan
     WHERE authorization_digest = NEW.authorization_digest AND assignment_outcome IS NULL
  ) THEN
    UPDATE addie_fixed_trace_component_smoke_authorizations SET status = 'completed'
     WHERE authorization_digest = NEW.authorization_digest AND status = 'consumed';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER addie_fixed_trace_component_smoke_assignment_denominator_complete
AFTER UPDATE OF assignment_outcome ON addie_fixed_trace_component_smoke_run_plan
FOR EACH ROW EXECUTE FUNCTION addie_fixed_trace_component_smoke_complete_assignment_denominator();

CREATE FUNCTION addie_fixed_trace_component_smoke_protect_authorization() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'authorization rows are immutable';
  END IF;
  IF NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest OR NEW.signed_payload_digest IS DISTINCT FROM OLD.signed_payload_digest
     OR NEW.signature_digest IS DISTINCT FROM OLD.signature_digest OR NEW.kid IS DISTINCT FROM OLD.kid
     OR NEW.nonce_commitment IS DISTINCT FROM OLD.nonce_commitment OR NEW.grant_version IS DISTINCT FROM OLD.grant_version
     OR NEW.stage_id IS DISTINCT FROM OLD.stage_id OR NEW.admission_version IS DISTINCT FROM OLD.admission_version
     OR NEW.aggregate_admission_fingerprint IS DISTINCT FROM OLD.aggregate_admission_fingerprint
     OR NEW.probes IS DISTINCT FROM OLD.probes OR NEW.router_cells IS DISTINCT FROM OLD.router_cells
     OR NEW.generation_cells IS DISTINCT FROM OLD.generation_cells OR NEW.total_cells IS DISTINCT FROM OLD.total_cells
     OR NEW.repetitions IS DISTINCT FROM OLD.repetitions OR NEW.assignments IS DISTINCT FROM OLD.assignments
     OR NEW.provider_dispatch_assignments IS DISTINCT FROM OLD.provider_dispatch_assignments
     OR NEW.local_terminal_assignments IS DISTINCT FROM OLD.local_terminal_assignments
     OR NEW.pre_dispatch_fault_assignments IS DISTINCT FROM OLD.pre_dispatch_fault_assignments
     OR NEW.maximum_planned_invocation_slots IS DISTINCT FROM OLD.maximum_planned_invocation_slots
     OR NEW.maximum_provider_invocations IS DISTINCT FROM OLD.maximum_provider_invocations
     OR NEW.reservation_microdollars IS DISTINCT FROM OLD.reservation_microdollars
     OR NEW.provider_ceiling_microdollars IS DISTINCT FROM OLD.provider_ceiling_microdollars
     OR NEW.pricing_cohort_digest IS DISTINCT FROM OLD.pricing_cohort_digest OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
     OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id THEN
    RAISE EXCEPTION 'authorization evidence is immutable';
  END IF;
  IF OLD.status <> 'consumed' OR NEW.status NOT IN ('completed', 'halted', 'unknown_exposure') THEN
    RAISE EXCEPTION 'authorization status is monotonic';
  END IF;
  IF NEW.status = 'completed' AND EXISTS (
    SELECT 1 FROM addie_fixed_trace_component_smoke_run_plan
     WHERE authorization_digest = NEW.authorization_digest AND assignment_outcome IS NULL
  ) THEN
    RAISE EXCEPTION 'authorization completion requires every assignment outcome';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER addie_fixed_trace_component_smoke_authorization_immutable
BEFORE UPDATE OR DELETE ON addie_fixed_trace_component_smoke_authorizations
FOR EACH ROW EXECUTE FUNCTION addie_fixed_trace_component_smoke_protect_authorization();

CREATE FUNCTION addie_fixed_trace_component_smoke_protect_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attempt rows are immutable';
  END IF;
  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest
     OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id OR NEW.invocation_ordinal IS DISTINCT FROM OLD.invocation_ordinal
     OR NEW.prepared_request_hmac IS DISTINCT FROM OLD.prepared_request_hmac OR NEW.intent_at IS DISTINCT FROM OLD.intent_at THEN
    RAISE EXCEPTION 'attempt intent evidence is immutable';
  END IF;
  IF OLD.status <> 'intent_recorded' OR NEW.status = 'intent_recorded' OR NEW.terminal_at IS NULL THEN
    RAISE EXCEPTION 'attempt status is monotonic';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER addie_fixed_trace_component_smoke_attempt_immutable
BEFORE UPDATE OR DELETE ON addie_fixed_trace_component_smoke_attempts
FOR EACH ROW EXECUTE FUNCTION addie_fixed_trace_component_smoke_protect_attempt();

CREATE CONSTRAINT TRIGGER addie_fixed_trace_component_smoke_plan_exact
AFTER INSERT OR UPDATE OR DELETE ON addie_fixed_trace_component_smoke_run_plan
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION addie_fixed_trace_component_smoke_check_plan();

-- The dated cohort has exactly four admitted profiles.  Keep the decimal
-- arithmetic in integer microdollar numerators so PostgreSQL independently
-- verifies the same one-time round-up as datedPricingCostMicros().  Cache
-- categories are additive for Anthropic and mutually-exclusive subsets of
-- input for OpenAI/Google; Google's cache writes are deliberately impossible.
CREATE FUNCTION addie_fixed_trace_component_smoke_expected_cost(
  p_profile_id TEXT, p_input INTEGER, p_output INTEGER, p_cache_read INTEGER, p_cache_write INTEGER
) RETURNS BIGINT
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  numerator NUMERIC;
  denominator NUMERIC;
BEGIN
  IF p_input < 0 OR p_output < 0 OR p_cache_read < 0 OR p_cache_write < 0 THEN
    RAISE EXCEPTION 'pricing usage cannot be negative';
  END IF;
  CASE p_profile_id
    WHEN 'anthropic-standard-2026-09:claude-haiku-4-5' THEN
      numerator := 100 * p_input + 500 * p_output + 10 * p_cache_read + 125 * p_cache_write; denominator := 100;
    WHEN 'anthropic-standard-2026-09:claude-sonnet-5' THEN
      numerator := 20 * p_input + 100 * p_output + 2 * p_cache_read + 25 * p_cache_write; denominator := 10;
    WHEN 'openai-gpt-5.6-luna-standard-2026-09-05' THEN
      IF p_cache_read + p_cache_write > p_input THEN RAISE EXCEPTION 'subset cache usage exceeds input'; END IF;
      numerator := 20 * (p_input - p_cache_read - p_cache_write) + 120 * p_output + 2 * p_cache_read + 25 * p_cache_write; denominator := 100;
    WHEN 'google-gemini-3.7-flash-through-2026-12-31' THEN
      IF p_cache_write <> 0 OR p_cache_read > p_input THEN RAISE EXCEPTION 'Google cache usage is not admitted'; END IF;
      numerator := 750 * (p_input - p_cache_read) + 3750 * p_output + 75 * p_cache_read; denominator := 1000;
    ELSE RAISE EXCEPTION 'pricing profile is not admitted';
  END CASE;
  RETURN ceil(numerator / denominator)::BIGINT;
END;
$$;

CREATE FUNCTION addie_fixed_trace_component_smoke_usage_within_limits(
  p_profile_id TEXT, p_input INTEGER, p_output INTEGER, p_cache_read INTEGER, p_cache_write INTEGER,
  p_latency INTEGER, p_max_input INTEGER, p_max_output INTEGER, p_timeout INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF p_input > p_max_input OR p_output > p_max_output OR p_latency > p_timeout THEN RETURN false; END IF;
  IF p_profile_id IN ('anthropic-standard-2026-09:claude-haiku-4-5', 'anthropic-standard-2026-09:claude-sonnet-5') THEN
    RETURN p_cache_read <= p_max_input AND p_cache_write <= p_max_input;
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION addie_fixed_trace_component_smoke_check_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  max_invocations SMALLINT;
  disposition VARCHAR(24);
  requested_provider VARCHAR(32);
  requested_model VARCHAR(128);
  requested_effort VARCHAR(64);
  pricing_profile VARCHAR(128);
  max_input INTEGER;
  max_output INTEGER;
  timeout_limit INTEGER;
  reserved BIGINT;
  expected_cost BIGINT;
  prior_spend BIGINT;
  reservation_limit BIGINT;
  provider_limit BIGINT;
  authorization_status VARCHAR(32);
  assignment_outcome VARCHAR(32);
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'intent_recorded' THEN
    RAISE EXCEPTION 'a provider attempt must begin as an intent';
  END IF;
  SELECT p.maximum_provider_invocations, p.disposition, p.requested_provider, p.requested_model, p.requested_effort, p.pricing_profile_id,
         p.max_input_tokens, p.max_output_tokens, p.timeout_ms,
         p.reserved_microdollars[NEW.invocation_ordinal], p.assignment_outcome
    INTO max_invocations, disposition, requested_provider, requested_model, requested_effort, pricing_profile,
         max_input, max_output, timeout_limit, reserved, assignment_outcome
    FROM addie_fixed_trace_component_smoke_run_plan AS p
   WHERE p.authorization_digest = NEW.authorization_digest AND p.assignment_id = NEW.assignment_id;
  IF disposition IS DISTINCT FROM 'provider_dispatch' OR NEW.invocation_ordinal > max_invocations THEN
    RAISE EXCEPTION 'attempt is not an admitted provider-dispatch ordinal';
  END IF;
  IF assignment_outcome IS NOT NULL THEN
    RAISE EXCEPTION 'provider assignment is already terminal';
  END IF;
  SELECT status, reservation_microdollars, provider_ceiling_microdollars
    INTO authorization_status, reservation_limit, provider_limit
    FROM addie_fixed_trace_component_smoke_authorizations
   WHERE authorization_digest = NEW.authorization_digest FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt authorization is absent';
  END IF;
  IF TG_OP = 'INSERT' AND authorization_status <> 'consumed' THEN
    RAISE EXCEPTION 'attempt authorization is not dispatchable';
  END IF;
  IF TG_OP = 'UPDATE' AND authorization_status <> 'consumed'
     AND NOT (authorization_status = 'unknown_exposure' AND NEW.status = 'unknown_exposure') THEN
    RAISE EXCEPTION 'attempt authorization cannot be settled';
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM addie_fixed_trace_component_smoke_attempts
     WHERE authorization_digest = NEW.authorization_digest AND status = 'intent_recorded'
  ) THEN
    RAISE EXCEPTION 'a prior provider intent remains unresolved';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.invocation_ordinal > 1 AND NOT EXISTS (
    SELECT 1 FROM addie_fixed_trace_component_smoke_attempts
     WHERE authorization_digest = NEW.authorization_digest AND assignment_id = NEW.assignment_id
       AND invocation_ordinal = NEW.invocation_ordinal - 1
       AND status = 'succeeded' AND response_disposition = 'tool_continuation_required'
  ) THEN
    RAISE EXCEPTION 'provider invocation ordinal lacks a terminal continuation predecessor';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'succeeded'
     AND (NEW.returned_provider IS DISTINCT FROM requested_provider OR NEW.returned_model IS DISTINCT FROM requested_model
          OR NEW.returned_effort IS DISTINCT FROM requested_effort) THEN
    RAISE EXCEPTION 'succeeded attempt identity differs from admitted plan';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'identity_mismatch'
     AND NEW.returned_provider = requested_provider AND NEW.returned_model = requested_model
     AND NEW.returned_effort = requested_effort THEN
    RAISE EXCEPTION 'identity mismatch requires differing returned identity';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.actual_cost_microdollars IS NOT NULL
     AND (NEW.returned_provider IS DISTINCT FROM requested_provider OR NEW.returned_model IS DISTINCT FROM requested_model
          OR NEW.returned_effort IS DISTINCT FROM requested_effort) THEN
    RAISE EXCEPTION 'actual cost requires admitted returned identity';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'invalid_limits'
     AND (NEW.returned_provider IS DISTINCT FROM requested_provider OR NEW.returned_model IS DISTINCT FROM requested_model
          OR NEW.returned_effort IS DISTINCT FROM requested_effort) THEN
    RAISE EXCEPTION 'observed limit cost requires admitted returned identity';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.actual_cost_microdollars IS NOT NULL OR NEW.observed_cost_microdollars IS NOT NULL) THEN
    expected_cost := addie_fixed_trace_component_smoke_expected_cost(pricing_profile, NEW.input_tokens, NEW.output_tokens,
      NEW.cache_read_tokens, NEW.cache_write_tokens);
    IF NEW.actual_cost_microdollars IS NOT NULL AND NEW.actual_cost_microdollars <> expected_cost THEN
      RAISE EXCEPTION 'attempt actual cost does not match admitted pricing';
    END IF;
    IF NEW.observed_cost_microdollars IS NOT NULL AND NEW.observed_cost_microdollars <> expected_cost THEN
      RAISE EXCEPTION 'attempt observed cost does not match admitted pricing';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'succeeded' AND NEW.response_disposition = 'tool_continuation_required'
     AND NEW.invocation_ordinal = max_invocations THEN
    -- A continuation beyond the admitted slot cannot be dispatched.  Preserve
    -- known receipt cost as observation, settle categorically, and halt.
    NEW.status := 'invalid_limits';
    NEW.response_disposition := NULL;
    NEW.observed_cost_microdollars := NEW.actual_cost_microdollars;
    NEW.actual_cost_microdollars := NULL;
    UPDATE addie_fixed_trace_component_smoke_authorizations
       SET status = 'halted'
     WHERE authorization_digest = NEW.authorization_digest AND status = 'consumed';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IN ('succeeded', 'provider_failed')
     AND NOT addie_fixed_trace_component_smoke_usage_within_limits(pricing_profile, NEW.input_tokens, NEW.output_tokens,
       NEW.cache_read_tokens, NEW.cache_write_tokens, NEW.latency_ms, max_input, max_output, timeout_limit) THEN
    NEW.status := 'invalid_limits';
    NEW.response_disposition := NULL;
    NEW.observed_cost_microdollars := NEW.actual_cost_microdollars;
    NEW.actual_cost_microdollars := NULL;
    UPDATE addie_fixed_trace_component_smoke_authorizations
       SET status = 'halted'
     WHERE authorization_digest = NEW.authorization_digest AND status = 'consumed';
  END IF;
  SELECT COALESCE(sum(actual_cost_microdollars), 0) INTO prior_spend
    FROM addie_fixed_trace_component_smoke_attempts
   WHERE authorization_digest = NEW.authorization_digest AND attempt_id <> NEW.attempt_id;
  IF NEW.actual_cost_microdollars IS NOT NULL AND (NEW.actual_cost_microdollars > reserved
     OR prior_spend + NEW.actual_cost_microdollars > reservation_limit
     OR prior_spend + NEW.actual_cost_microdollars > provider_limit) THEN
    NEW.status := 'invalid_limits';
    NEW.response_disposition := NULL;
    NEW.observed_cost_microdollars := NEW.actual_cost_microdollars;
    NEW.actual_cost_microdollars := NULL;
    UPDATE addie_fixed_trace_component_smoke_authorizations
       SET status = 'halted'
     WHERE authorization_digest = NEW.authorization_digest AND status = 'consumed';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status NOT IN ('intent_recorded', 'succeeded') THEN
    UPDATE addie_fixed_trace_component_smoke_authorizations
       SET status = CASE WHEN NEW.status = 'invalid_limits' THEN 'halted' ELSE 'unknown_exposure' END,
           unknown_exposure_at = CASE WHEN NEW.status = 'invalid_limits' THEN NULL ELSE clock_timestamp() END
     WHERE authorization_digest = NEW.authorization_digest AND status = 'consumed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER addie_fixed_trace_component_smoke_attempt_exact
BEFORE INSERT OR UPDATE ON addie_fixed_trace_component_smoke_attempts
FOR EACH ROW EXECUTE FUNCTION addie_fixed_trace_component_smoke_check_attempt();

COMMENT ON TABLE addie_fixed_trace_component_smoke_authorizations IS
  'One-use signed private smoke grants, stored only as digests and categorical consumption state; no bearer data or text';
COMMENT ON TABLE addie_fixed_trace_component_smoke_run_plan IS
  'Exact admitted 168-entry private smoke plan, persisted before any future provider dispatch';
COMMENT ON TABLE addie_fixed_trace_component_smoke_attempts IS
  'Intent-before-terminal, HMAC-only provider attempt evidence; unknown exposure must halt the authorization';
