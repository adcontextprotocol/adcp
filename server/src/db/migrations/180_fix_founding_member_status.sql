-- Fix founding member status for profiles created before cutoff
-- The original migration 147 only ran once, so profiles created afterwards
-- were not automatically flagged as founding members

UPDATE member_profiles
SET is_founding_member = TRUE
WHERE created_at < '2026-04-01'::timestamptz
  AND is_founding_member = FALSE;
