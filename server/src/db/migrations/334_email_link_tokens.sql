-- Email link verification tokens and user email aliases
-- Supports self-service account linking: user proves ownership of another email,
-- then we merge the duplicate account's data into their primary account.

CREATE TABLE IF NOT EXISTS email_link_tokens (
  id SERIAL PRIMARY KEY,
  token VARCHAR(64) NOT NULL UNIQUE,
  primary_workos_user_id VARCHAR(255) NOT NULL REFERENCES users(workos_user_id) ON DELETE CASCADE,
  target_email VARCHAR(255) NOT NULL,
  target_workos_user_id VARCHAR(255),
  status VARCHAR(20) DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'verified', 'expired', 'revoked')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  verified_at TIMESTAMP WITH TIME ZONE,
  merge_summary JSONB
);

-- token column already has a UNIQUE index, so no extra index needed
CREATE INDEX idx_email_link_tokens_primary ON email_link_tokens(primary_workos_user_id);

CREATE TABLE IF NOT EXISTS user_email_aliases (
  id SERIAL PRIMARY KEY,
  workos_user_id VARCHAR(255) NOT NULL REFERENCES users(workos_user_id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  verified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(workos_user_id, email)
);

CREATE INDEX idx_user_email_aliases_email ON user_email_aliases(email);
