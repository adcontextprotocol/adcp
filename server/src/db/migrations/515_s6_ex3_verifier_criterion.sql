-- Make S6 exercise 3 (governance token verification) hands-on for the
-- REJECTION cases. When S6 shipped, the training agent was a governance-token
-- issuer with no verifier, so tamper/revocation rejection was gated as
-- reasoning only. The verifier now ships (verify_governance_token comply
-- scenario), so a learner can observe a valid token accepted and a tampered /
-- misaddressed / revoked token rejected. This adds the verifier sandbox action
-- and a gated hands-on criterion to s6_ex3. Idempotent / re-runnable.

-- 1) Add the verify_governance_token sandbox action to s6_ex3 (if absent).
CREATE OR REPLACE FUNCTION _add_s6_ex3_verifier_action()
RETURNS void AS $$
DECLARE
  defs jsonb;
  updated jsonb := '[]'::jsonb;
  ex jsonb;
  actions jsonb;
  already_present boolean;
  exercise_matched boolean := false;
BEGIN
  SELECT exercise_definitions INTO defs FROM certification_modules WHERE id = 'S6';
  IF defs IS NULL OR jsonb_typeof(defs) <> 'array' THEN
    RAISE EXCEPTION 'Module S6 not found or has no exercise_definitions array';
  END IF;

  FOR ex IN SELECT * FROM jsonb_array_elements(defs)
  LOOP
    IF ex->>'id' = 's6_ex3' THEN
      exercise_matched := true;
      actions := COALESCE(ex->'sandbox_actions', '[]'::jsonb);
      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(actions) a WHERE a->>'tool' = 'comply_test_controller'
      ) INTO already_present;
      IF NOT already_present THEN
        actions := actions || jsonb_build_array(jsonb_build_object(
          'tool', 'comply_test_controller',
          'guidance', 'Run the sandbox verifier (scenario verify_governance_token) to check a token end to end: pass the governance_context you obtained to see it accepted; add tamper to mutate a claim (the signature step rejects it); use mode wrong_aud_demo for the confused-deputy aud rejection and mode revoked_demo for the revocation rejection. Read the per-step trace and the spec error code on each.'
        ));
        ex := jsonb_set(ex, '{sandbox_actions}', actions);
      END IF;
    END IF;
    updated := updated || jsonb_build_array(ex);
  END LOOP;

  IF NOT exercise_matched THEN
    RAISE EXCEPTION 'Exercise s6_ex3 not found in module S6';
  END IF;

  UPDATE certification_modules SET exercise_definitions = updated WHERE id = 'S6';
END;
$$ LANGUAGE plpgsql;

SELECT _add_s6_ex3_verifier_action();
DROP FUNCTION _add_s6_ex3_verifier_action();

-- 2) Gated hands-on criterion (define -> call -> DROP; idempotent via the
--    in-function already_present check; emitted as a {id,text} object).
CREATE OR REPLACE FUNCTION _append_criterion(
  p_module_id text,
  p_exercise_id text,
  p_criterion_id text,
  p_text text
) RETURNS void AS $$
DECLARE
  defs jsonb;
  updated jsonb := '[]'::jsonb;
  ex jsonb;
  criteria jsonb;
  already_present boolean;
  exercise_matched boolean := false;
BEGIN
  SELECT exercise_definitions INTO defs
  FROM certification_modules
  WHERE id = p_module_id;

  IF defs IS NULL OR jsonb_typeof(defs) <> 'array' THEN
    RAISE EXCEPTION 'Module % not found or has no exercise_definitions array', p_module_id;
  END IF;

  FOR ex IN SELECT * FROM jsonb_array_elements(defs)
  LOOP
    IF ex->>'id' = p_exercise_id THEN
      exercise_matched := true;
      criteria := COALESCE(ex->'success_criteria', '[]'::jsonb);

      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(criteria) c
        WHERE c->>'id' = p_criterion_id
      ) INTO already_present;

      IF NOT already_present THEN
        criteria := criteria || jsonb_build_array(
          jsonb_build_object('id', p_criterion_id, 'text', p_text)
        );
        ex := jsonb_set(ex, '{success_criteria}', criteria);
      END IF;
    END IF;
    updated := updated || jsonb_build_array(ex);
  END LOOP;

  IF NOT exercise_matched THEN
    RAISE EXCEPTION 'Exercise % not found in module %', p_exercise_id, p_module_id;
  END IF;

  UPDATE certification_modules
  SET exercise_definitions = updated
  WHERE id = p_module_id;
END;
$$ LANGUAGE plpgsql;

SELECT _append_criterion('S6', 's6_ex3', 's6_ex3_sc_observe_verifier_rejections',
  'Uses the sandbox verifier (verify_governance_token) to observe a valid governance token accepted and three rejections — a tampered token, a token addressed to a different seller, and a token signed under a revoked key — and reads the spec error code on each (governance_token_invalid for a broken signature, governance_token_not_applicable for an aud mismatch, governance_token_revoked for a revoked key), explaining the attack each failing step closes.');

DROP FUNCTION _append_criterion(text, text, text, text);
