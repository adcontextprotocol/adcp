-- Migration: 384_marketing_opt_in.sql
-- Add explicit marketing opt-in tracking for GDPR compliance.
-- NULL means the user signed up before this checkbox existed.

ALTER TABLE user_email_preferences
  ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN,
  ADD COLUMN IF NOT EXISTS marketing_opt_in_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN user_email_preferences.marketing_opt_in IS 'Explicit marketing consent captured at signup. NULL = legacy user who never saw the checkbox.';
COMMENT ON COLUMN user_email_preferences.marketing_opt_in_at IS 'When the user made their marketing opt-in choice.';
