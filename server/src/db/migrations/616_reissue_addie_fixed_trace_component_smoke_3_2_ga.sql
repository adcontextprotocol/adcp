-- Migrations 582 and 583 are already shipped. AdCP 3.2 is now the stable
-- docs and schema default, so the version-parameter descriptions of the
-- isolated search_docs and get_doc smoke descriptors (and the live
-- search_docs, get_doc and schema tool descriptions they snapshot) changed
-- from "stable 3.1; use 3.2 for the current preview" to "stable 3.2". That
-- deliberately changes the component-smoke aggregate admission fingerprint.
-- Reissue the private smoke-plan authority forward-only, following 583:
-- historical authorization records remain readable, but only the newly
-- admitted plan can satisfy the plan-group check that gates every new
-- provider-facing dispatch intent.

ALTER TABLE addie_fixed_trace_component_smoke_authorizations
  DROP CONSTRAINT IF EXISTS addie_fixed_trace_smoke_admission_fingerprint_check;

ALTER TABLE addie_fixed_trace_component_smoke_authorizations
  ADD CONSTRAINT addie_fixed_trace_smoke_admission_fingerprint_check
  CHECK (aggregate_admission_fingerprint IN (
    '731930c18475672a0ec6b44c9ff91fa89d30c441e34af32b536a28258271077d',
    '817ab57d30cc89dab4a81016f5c826857b8dc2a83e2f73aa0b7eb9c82f0b5d71',
    'fa331c387fd038a7db836d46fe4061afbbeec4ae2fc49b84c679046369058308'
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

  IF admission_fingerprint <> 'fa331c387fd038a7db836d46fe4061afbbeec4ae2fc49b84c679046369058308'
     OR plan_count <> 168 OR dispatch_count <> 126 OR local_count <> 21 OR pre_dispatch_count <> 21
     OR slots <> 192 OR reserved <> 2819484 OR invalid_reservation
     OR addie_fixed_trace_component_smoke_plan_manifest_digest(p_authorization_digest) <> 'bda91890329f1da236a0cddbafa65afe25ff986fb1aa0b04594d2c79d521f70a' THEN
    RAISE EXCEPTION 'fixed-trace component smoke plan is not the admitted exact plan';
  END IF;
END;
$$;

-- Migration 583 already routes every new dispatch intent through
-- addie_fixed_trace_component_smoke_check_plan_group via the
-- addie_fixed_trace_component_smoke_attempt_plan_guard trigger, and the
-- deferred plan trigger from 582 calls the same function. Replacing the
-- function above is therefore enough: a plan committed under 582 or 583 now
-- fails closed on its next dispatch intent, and only the reissued plan can
-- record new provider-facing work.
