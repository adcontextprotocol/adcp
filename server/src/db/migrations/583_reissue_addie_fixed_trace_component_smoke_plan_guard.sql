-- Migration 582 is already shipped. Reissue its private smoke-plan authority
-- forward-only after the experimental-design fingerprint changed. Historical
-- authorization records remain readable, but only the newly admitted plan can
-- satisfy a deferred plan-group check after this migration.

ALTER TABLE addie_fixed_trace_component_smoke_authorizations
  DROP CONSTRAINT IF EXISTS addie_fixed_trace_component_smoke_authorizations_aggregate_admission_fingerprint_check;

ALTER TABLE addie_fixed_trace_component_smoke_authorizations
  ADD CONSTRAINT addie_fixed_trace_component_smoke_authorizations_aggregate_admission_fingerprint_check
  CHECK (aggregate_admission_fingerprint IN (
    '731930c18475672a0ec6b44c9ff91fa89d30c441e34af32b536a28258271077d',
    '817ab57d30cc89dab4a81016f5c826857b8dc2a83e2f73aa0b7eb9c82f0b5d71'
  ));

CREATE OR REPLACE FUNCTION addie_fixed_trace_component_smoke_check_plan_group(p_authorization_digest CHAR(64)) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  plan_count INTEGER;
  dispatch_count INTEGER;
  local_count INTEGER;
  pre_dispatch_count INTEGER;
  slots INTEGER;
  reserved BIGINT;
  invalid_reservation BOOLEAN;
  admission_fingerprint CHAR(64);
BEGIN
  SELECT aggregate_admission_fingerprint
    INTO admission_fingerprint
    FROM addie_fixed_trace_component_smoke_authorizations
   WHERE authorization_digest = p_authorization_digest;

  SELECT count(*), count(*) FILTER (WHERE disposition = 'provider_dispatch'),
         count(*) FILTER (WHERE disposition = 'local_terminal'), count(*) FILTER (WHERE disposition = 'pre_dispatch_fault'),
         COALESCE(sum(maximum_provider_invocations), 0),
         COALESCE(sum((SELECT sum(value) FROM unnest(reserved_microdollars) AS value)), 0),
         COALESCE(bool_or(EXISTS (SELECT 1 FROM unnest(reserved_microdollars) AS value WHERE value <= 0 OR value > 2819484)), false)
   INTO plan_count, dispatch_count, local_count, pre_dispatch_count, slots, reserved, invalid_reservation
    FROM addie_fixed_trace_component_smoke_run_plan
   WHERE authorization_digest = p_authorization_digest;

  IF admission_fingerprint <> '817ab57d30cc89dab4a81016f5c826857b8dc2a83e2f73aa0b7eb9c82f0b5d71'
     OR plan_count <> 168 OR dispatch_count <> 126 OR local_count <> 21 OR pre_dispatch_count <> 21
     OR slots <> 192 OR reserved <> 2819484 OR invalid_reservation
     OR addie_fixed_trace_component_smoke_plan_manifest_digest(p_authorization_digest) <> 'c9b2b82185f4723cb8059e0c2064d946d825939ef84b813d3df8f3ef11656530' THEN
    RAISE EXCEPTION 'fixed-trace component smoke plan is not the admitted exact plan';
  END IF;
END;
$$;

-- A plan written and committed under migration 582 never changes again, so
-- its deferred plan trigger cannot observe this reissue.  Gate every *new*
-- dispatch intent through the reissued authority instead.  Historical plans
-- and attempt evidence remain readable; only new provider-facing work needs
-- to satisfy the current exact admission fingerprint and manifest.
CREATE OR REPLACE FUNCTION addie_fixed_trace_component_smoke_guard_attempt_plan() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM addie_fixed_trace_component_smoke_check_plan_group(NEW.authorization_digest);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS addie_fixed_trace_component_smoke_attempt_plan_guard
  ON addie_fixed_trace_component_smoke_attempts;

CREATE TRIGGER addie_fixed_trace_component_smoke_attempt_plan_guard
BEFORE INSERT ON addie_fixed_trace_component_smoke_attempts
FOR EACH ROW EXECUTE FUNCTION addie_fixed_trace_component_smoke_guard_attempt_plan();
