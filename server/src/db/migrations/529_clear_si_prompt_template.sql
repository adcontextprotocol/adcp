-- Stage removal of mutable SI system prompts without breaking old instances
-- during a rolling deploy. Old code falls back to its built-in policy when
-- this value is NULL; new code never reads or writes the column. Drop the
-- compatibility column only after this application version is fully rolled
-- out and the prior version can no longer be serving traffic.
UPDATE member_profiles
SET si_prompt_template = NULL
WHERE si_prompt_template IS NOT NULL;

ALTER TABLE member_profiles
DROP CONSTRAINT IF EXISTS member_profiles_si_prompt_template_must_be_null;

ALTER TABLE member_profiles
ADD CONSTRAINT member_profiles_si_prompt_template_must_be_null
CHECK (si_prompt_template IS NULL);

COMMENT ON COLUMN member_profiles.si_prompt_template IS
  'Deprecated compatibility column. Must remain NULL; application code does not read or write it.';
