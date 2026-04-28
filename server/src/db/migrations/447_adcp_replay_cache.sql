-- RFC 9421 nonce-replay cache, shared across all training-agent instances.
--
-- Replaces the per-process `InMemoryReplayStore` from `@adcp/client`. With
-- Fly running >= 2 web machines, in-memory replay state can't catch
-- cross-instance replays — a captured signature replayed against a sibling
-- machine that hasn't seen the nonce locally would be accepted (#3338,
-- grader vector neg/016).
--
-- Schema mirrors the SDK's `getReplayStoreMigration()` output (5.21.0+):
-- `(keyid, scope, nonce)` PK serializes concurrent inserts; `expires_at`
-- carries the per-row TTL since Postgres has no native TTL. The
-- `sweepExpiredReplays` helper scheduled in the boot path deletes
-- expired rows on a 60s interval.

CREATE TABLE IF NOT EXISTS adcp_replay_cache (
  keyid       TEXT NOT NULL,
  scope       TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (keyid, scope, nonce)
);

CREATE INDEX IF NOT EXISTS idx_adcp_replay_cache_expires_at
  ON adcp_replay_cache(expires_at);

CREATE INDEX IF NOT EXISTS idx_adcp_replay_cache_keyid_scope_active
  ON adcp_replay_cache(keyid, scope, expires_at);
