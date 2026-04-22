-- Idempotency replay cache for the training agent (AdCP v3 §idempotency).
-- Table name and schema come from @adcp/client/server's getIdempotencyMigration()
-- so any future schema change in the SDK requires a follow-up migration here.
CREATE TABLE IF NOT EXISTS "adcp_idempotency" (
  scoped_key    TEXT PRIMARY KEY,
  payload_hash  TEXT NOT NULL,
  response      JSONB NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adcp_idempotency_expires_at
  ON "adcp_idempotency"(expires_at);
