-- Keep the stored B3 curriculum aligned with the learner-facing reporting
-- references. The old criterion asked what was available two days after a
-- flight while supplying only c3/c7 names; those names do not define protocol
-- deadlines. Sellers declare accumulation and availability per product.

DO $$
DECLARE
  definitions jsonb;
  updated_definitions jsonb := '[]'::jsonb;
  exercise jsonb;
  criteria jsonb;
  updated_criteria jsonb;
  criterion jsonb;
  found_criterion boolean := false;
BEGIN
  SELECT exercise_definitions INTO definitions
  FROM certification_modules
  WHERE id = 'B3';

  IF definitions IS NULL OR jsonb_typeof(definitions) <> 'array' THEN
    RAISE EXCEPTION 'Module B3 not found or has no exercise_definitions array';
  END IF;

  FOR exercise IN SELECT * FROM jsonb_array_elements(definitions)
  LOOP
    IF exercise->>'id' = 'b3_ex1' THEN
      criteria := COALESCE(exercise->'success_criteria', '[]'::jsonb);
      updated_criteria := '[]'::jsonb;

      FOR criterion IN SELECT * FROM jsonb_array_elements(criteria)
      LOOP
        IF criterion->>'id' = 'b3_ex1_sc_broadcast_delivery_seller_communication' THEN
          found_criterion := true;
          criterion := jsonb_set(
            criterion,
            '{text}',
            to_jsonb(
              'Given seller-declared C3/C7 measurement windows, uses duration_days and expected_availability_days rather than the window names to determine availability; interprets measurement_window, supersedes_window, is_final, and finalized_at; and explains how a window_update replaces provisional delivery without mislabeling it as underdelivery.'::text
            )
          );
        END IF;
        updated_criteria := updated_criteria || jsonb_build_array(criterion);
      END LOOP;

      exercise := jsonb_set(exercise, '{success_criteria}', updated_criteria);
    END IF;
    updated_definitions := updated_definitions || jsonb_build_array(exercise);
  END LOOP;

  IF NOT found_criterion THEN
    RAISE EXCEPTION 'B3 broadcast delivery criterion not found';
  END IF;

  UPDATE certification_modules
  SET exercise_definitions = updated_definitions
  WHERE id = 'B3';
END;
$$;
