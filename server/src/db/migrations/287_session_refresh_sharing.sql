-- Share refreshed WorkOS sessions across Fly.io machines.
-- When one machine refreshes a session (consuming the single-use refresh token),
-- it stores the new sealed session here so other machines can find it
-- instead of failing with a consumed refresh token.

CREATE TABLE session_refreshes (
  old_cookie_hash TEXT PRIMARY KEY,
  new_sealed_session TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_session_refreshes_expires ON session_refreshes (expires_at);
