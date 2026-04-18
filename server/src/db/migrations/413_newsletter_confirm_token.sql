-- Single-use confirmation token for the non-member newsletter subscribe flow.
-- Populated by POST /api/newsletter/subscribe, cleared by GET /newsletter/confirm
-- after flipping marketing_opt_in to true. 24-hour expiry enforced in queries.

ALTER TABLE user_email_preferences
  ADD COLUMN IF NOT EXISTS confirm_token TEXT,
  ADD COLUMN IF NOT EXISTS confirm_token_expires_at TIMESTAMP WITH TIME ZONE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_preferences_confirm_token
  ON user_email_preferences (confirm_token)
  WHERE confirm_token IS NOT NULL;

COMMENT ON COLUMN user_email_preferences.confirm_token IS 'Single-use token for newsletter subscribe confirmation. Cleared after confirm.';
COMMENT ON COLUMN user_email_preferences.confirm_token_expires_at IS 'When the confirm_token stops being valid.';
