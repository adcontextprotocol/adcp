-- Keep the stored S1 sandbox guidance aligned with the training seller's
-- matched immutable checkpoint. Migration 550 introduced the exercise during
-- beta; deployed databases need an explicit follow-up rather than an edit to
-- that historical migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM certification_modules WHERE id = 'S1') THEN
    RAISE EXCEPTION 'Module S1 not found';
  END IF;

  UPDATE certification_modules
  SET exercise_definitions = replace(
    exercise_definitions::text,
    'On the exact 3.2 beta wire,',
    'On the exact AdCP 3.2-rc.0 wire,'
  )::jsonb
  WHERE id = 'S1'
    AND exercise_definitions::text LIKE '%On the exact 3.2 beta wire,%';
END;
$$;
