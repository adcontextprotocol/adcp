-- Add SuccessCriterion IDs for broadcast TV delivery window demonstrations
-- introduced in #2047 (depends on broadcast TV protocol PR #2046, merged 2026-04-14).
-- S1 ex8: interpret get_media_buy_delivery measurement windows (live/c3/c7).
-- B3 ex2: represent partial delivery correctly to the buyer.

-- Re-define the helper that 407_curriculum_3_0_criterion_ids.sql created and
-- then dropped at the end of its run. New criterion-appending migrations need
-- to redefine the function locally; it is not a persistent fixture.
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

SELECT _append_criterion('S1', 's1_ex1', 's1_ex1_sc_broadcast_delivery_windows',
  'Calls get_media_buy_delivery on a broadcast buy and correctly interprets live/c3/c7 measurement window fields; explains that c7 DVR accumulation closes seven days post-air with additional vendor processing delay, and identifies incomplete data as by-design maturation rather than underdelivery.');

SELECT _append_criterion('B3', 'b3_ex1', 'b3_ex1_sc_broadcast_delivery_seller_communication',
  'Given a broadcast product with c3/c7 measurement windows, describes what data is available two days after the flight date, explains why c7 is incomplete, and specifies how the seller should represent partial delivery to prevent buyer misreading it as underdelivery.');

DROP FUNCTION _append_criterion(text, text, text, text);
