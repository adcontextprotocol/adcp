-- Generic document store for AdCP domain objects (via @adcp/client's
-- PostgresStateStore). Replaces in-memory session state in the training
-- agent so media buys, property lists, creatives, etc. survive across
-- Fly.io machines.
--
-- DDL is the canonical output of @adcp/client's getAdcpStateMigration().

CREATE TABLE IF NOT EXISTS adcp_state (
  collection    TEXT NOT NULL,
  id            TEXT NOT NULL,
  data          JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS idx_adcp_state_collection
  ON adcp_state(collection);

CREATE INDEX IF NOT EXISTS idx_adcp_state_updated
  ON adcp_state(updated_at);
