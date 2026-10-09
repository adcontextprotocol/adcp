-- Keep the stored S1 sandbox guidance aligned with the generally available
-- AdCP 3.2 release (wire pin "3.2"). Historical migrations stay unchanged;
-- deployed databases advance through this explicit replacement.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM certification_modules WHERE id = 'S1') THEN
    RAISE EXCEPTION 'Module S1 not found';
  END IF;

  UPDATE certification_modules
  SET exercise_definitions = replace(
    exercise_definitions::text,
    'On the exact AdCP 3.2-rc.1 wire,',
    'On the AdCP 3.2 wire,'
  )::jsonb
  WHERE id = 'S1'
    AND exercise_definitions::text LIKE '%On the exact AdCP 3.2-rc.1 wire,%';
END;
$$;
