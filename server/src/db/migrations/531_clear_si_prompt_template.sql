-- Stage removal of mutable SI system prompts without breaking old instances
-- during a rolling deploy. Old code falls back to its built-in policy when
-- this value is NULL; new code never reads or writes the column. Do not add a
-- null-only constraint yet: an old instance may still write this compatibility
-- column while the new version is rolling out. Re-clear and drop the column in
-- a later release after the prior version can no longer be serving traffic.
UPDATE member_profiles
SET si_prompt_template = NULL
WHERE si_prompt_template IS NOT NULL;

ALTER TABLE member_profiles
DROP CONSTRAINT IF EXISTS member_profiles_si_prompt_template_must_be_null;

COMMENT ON COLUMN member_profiles.si_prompt_template IS
  'Deprecated rolling-deploy compatibility column. Current application code ignores it.';
