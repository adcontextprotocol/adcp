-- Native desktop OAuth v2 transient state.
--
-- The browser callback carries only a random pending id. The desktop deep
-- link carries only a short-lived authorization code. Both values are stored
-- as SHA-256 hashes and atomically consumed by DELETE ... RETURNING.

CREATE TABLE IF NOT EXISTS native_oauth_pending_auths (
  id_hash TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_native_oauth_pending_auths_expires
  ON native_oauth_pending_auths (expires_at);

CREATE TABLE IF NOT EXISTS native_oauth_grants (
  code_hash TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_native_oauth_grants_expires
  ON native_oauth_grants (expires_at);

COMMENT ON TABLE native_oauth_pending_auths IS
  'Single-use native desktop OAuth requests awaiting the WorkOS callback';
COMMENT ON TABLE native_oauth_grants IS
  'PKCE-bound single-use native desktop authorization grants';
