-- Ensure only one user can claim a given email alias.
-- The original composite UNIQUE(workos_user_id, email) allowed two different
-- users to claim the same email, creating a race condition in auto-merge.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_aliases_email_unique
  ON user_email_aliases (LOWER(email));
