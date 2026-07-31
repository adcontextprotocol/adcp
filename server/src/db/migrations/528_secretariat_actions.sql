-- Secretariat console (Stage A): a human-approved action queue for the AAO
-- Secretariat. Proposer jobs write rows here; nothing executes until an
-- admin approves it in the console. See specs/spec-guardian.md.
--
-- State machine: proposed -> approved -> executing -> done
--                proposed -> rejected
--                approved -> failed -> proposed (via retry)
-- Enforced in application code (server/src/db/secretariat-actions-db.ts),
-- not a DB CHECK constraint, so the allowed-kind allowlist can evolve
-- without a migration.

CREATE TABLE IF NOT EXISTS secretariat_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind VARCHAR(50) NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'proposed',
  origin VARCHAR(100) NOT NULL,
  dedupe_key TEXT UNIQUE NULL,
  edited BOOLEAN NOT NULL DEFAULT false,
  result JSONB NULL,
  error TEXT NULL,
  decided_by TEXT NULL,
  decided_at TIMESTAMPTZ NULL,
  executed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_secretariat_actions_status_created
  ON secretariat_actions(status, created_at);

CREATE TRIGGER update_secretariat_actions_updated_at
  BEFORE UPDATE ON secretariat_actions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
