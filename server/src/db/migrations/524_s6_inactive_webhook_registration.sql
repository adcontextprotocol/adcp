-- Keep the S6 SSRF lab honest while account notification targets lack a
-- proof-of-control activation challenge. Learners may register only inactive
-- targets; a public target demonstrates URL acceptance, not delivery authority.

DO $$
DECLARE
  lp jsonb;
  defs jsonb;
  updated jsonb := '[]'::jsonb;
  scenarios jsonb := '[]'::jsonb;
  scenario jsonb;
  ex jsonb;
  actions jsonb;
  action jsonb;
  new_actions jsonb;
  criteria jsonb;
  criterion jsonb;
  new_criteria jsonb;
BEGIN
  SELECT lesson_plan, exercise_definitions INTO lp, defs
  FROM certification_modules
  WHERE id = 'S6';

  IF lp IS NULL OR defs IS NULL THEN
    RAISE EXCEPTION 'Module S6 not found or curriculum JSON is missing';
  END IF;

  FOR scenario IN SELECT * FROM jsonb_array_elements(COALESCE(lp->'demo_scenarios', '[]'::jsonb))
  LOOP
    IF scenario->'tools' = '["sync_accounts"]'::jsonb THEN
      scenario := jsonb_set(
        scenario,
        '{description}',
        to_jsonb('Open with a live SSRF block. Make two sync_accounts dry runs with distinct idempotency keys and the same sandbox account fields (brand.domain, operator, billing operator, sandbox true). Each call registers one inactive notification_config (active false): first use https://169.254.169.254/latest/meta-data/, then use the control url https://webhook.example.com/notify.'::text)
      );
      scenario := jsonb_set(
        scenario,
        '{expected_outcome}',
        to_jsonb('The metadata target is refused synchronously with a VALIDATION_ERROR on notification_configs[].url, while the public host is accepted as an inactive registration. The sandbox does not authorize delivery until a signed proof-of-control challenge exists. The hook: URL validation happens at registration, before any outbound delivery can turn the agent into an SSRF weapon.'::text)
      );
    END IF;
    scenarios := scenarios || jsonb_build_array(scenario);
  END LOOP;
  lp := jsonb_set(lp, '{demo_scenarios}', scenarios);

  FOR ex IN SELECT * FROM jsonb_array_elements(defs)
  LOOP
    IF ex->>'id' = 's6_ex4' THEN
      new_actions := '[]'::jsonb;
      actions := COALESCE(ex->'sandbox_actions', '[]'::jsonb);
      FOR action IN SELECT * FROM jsonb_array_elements(actions)
      LOOP
        IF action->>'tool' = 'sync_accounts' THEN
          action := jsonb_set(
            action,
            '{guidance}',
            to_jsonb('Make two sync_accounts dry runs with distinct idempotency keys, each registering one notification_config with active false: first target https://169.254.169.254/latest/meta-data/, then target a public host. Observe that the metadata target is refused synchronously by the SSRF guard while the public host is accepted only as inactive. Then predict what changes if the metadata IP uses http:// instead of https://. Do not claim delivery activation: that requires a future signed proof-of-control challenge.'::text)
          );
        END IF;
        new_actions := new_actions || jsonb_build_array(action);
      END LOOP;
      ex := jsonb_set(ex, '{sandbox_actions}', new_actions);

      new_criteria := '[]'::jsonb;
      criteria := COALESCE(ex->'success_criteria', '[]'::jsonb);
      FOR criterion IN SELECT * FROM jsonb_array_elements(criteria)
      LOOP
        IF criterion->>'id' = 's6_ex4_sc_register_blocked_webhook' THEN
          criterion := jsonb_set(
            criterion,
            '{text}',
            to_jsonb('Uses separate sync_accounts dry runs to register inactive notification_config targets (active false), shows the synchronous VALIDATION_ERROR for the cloud-metadata URL, contrasts it with a public host accepted as inactive, and explains both why HTTPS metadata targets fail the SSRF guard and why the sandbox cannot activate delivery before a signed proof-of-control challenge exists.'::text)
          );
        END IF;
        new_criteria := new_criteria || jsonb_build_array(criterion);
      END LOOP;
      ex := jsonb_set(ex, '{success_criteria}', new_criteria);
    END IF;
    updated := updated || jsonb_build_array(ex);
  END LOOP;

  UPDATE certification_modules
  SET lesson_plan = lp,
      exercise_definitions = updated
  WHERE id = 'S6';
END;
$$ LANGUAGE plpgsql;
