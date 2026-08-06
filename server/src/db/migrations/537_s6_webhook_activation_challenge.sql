-- The account webhook proof-of-control flow is now live. Replace S6's
-- inactive-only stopgap with a signed activation and DNS-rebinding exercise.

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
        to_jsonb('Open with the live account-webhook security flow. First show the synchronous SSRF rejection for https://169.254.169.254/latest/meta-data/. Then register an inactive public receiver, configure it to verify the RFC 9421 webhook.challenge and echo its nonce, and reactivate the same subscriber. Finally pause it, re-point the exercise hostname to a reserved address, and attempt reactivation so the learner sees URL/DNS validation run again immediately before enablement.'::text)
      );
      scenario := jsonb_set(
        scenario,
        '{expected_outcome}',
        to_jsonb('The metadata target is refused without a network call. The controlled public receiver observes a signed challenge binding account_id, subscriber_id, delivery_auth, event_types, the exact normalized URL through @target-uri, and expiry through the signature parameters; a valid single-use echo activates the stored subscriber. Reactivation after the exercise hostname resolves to a reserved address fails closed on notification_configs[].url, demonstrating that registration-time validation cannot be reused across a pause/reactivation boundary.'::text)
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
            to_jsonb('Use a public receiver endpoint you control. Register it with active false, then configure the receiver to verify the RFC 9421 webhook.challenge, confirm every registration binding, and return exactly {"challenge":"<received nonce>"}. Re-send the same subscriber with active true and observe activation. Pause it, re-point the exercise hostname to a reserved address, and try active true again; the training agent must re-run the full SSRF check and refuse reactivation. Also submit https://169.254.169.254/latest/meta-data/ directly to observe the literal metadata-address rejection.'::text)
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
            to_jsonb('Shows the metadata-address SSRF rejection, activates a previously inactive subscriber only after verifying and echoing the signed tuple-bound challenge, and demonstrates that pause/reactivation re-runs DNS and reserved-address validation so a re-pointed hostname cannot inherit the earlier proof.'::text)
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
