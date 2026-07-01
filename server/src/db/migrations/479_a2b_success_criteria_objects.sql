-- A2B (migration 478) shipped exercise_definitions[].success_criteria as plain strings,
-- but the SuccessCriterion contract is { id, text } (see certification-db.ts).
-- demonstrations-fairness.test.ts asserts every criterion has an id, so main is red.
-- Convert each string criterion into { id: "<exercise_id>_c<n>", text: <string> }.
-- Idempotent: criteria already in object form pass through unchanged.

UPDATE certification_modules
SET exercise_definitions = (
  SELECT jsonb_agg(
    jsonb_set(
      ex.value,
      '{success_criteria}',
      (
        SELECT jsonb_agg(
          CASE
            WHEN jsonb_typeof(c.value) = 'string'
              THEN jsonb_build_object(
                'id', (ex.value->>'id') || '_c' || c.ordinality::text,
                'text', c.value
              )
            ELSE c.value
          END
          ORDER BY c.ordinality
        )
        FROM jsonb_array_elements(ex.value->'success_criteria') WITH ORDINALITY AS c(value, ordinality)
      )
    )
    ORDER BY ex.ordinality
  )
  FROM jsonb_array_elements(exercise_definitions) WITH ORDINALITY AS ex(value, ordinality)
)
WHERE id = 'A2B';
