-- Postgres-backed state store for the multi-tenant training-agent runtime.
--
-- The SDK's `createAdcpServer` defaults to an in-memory module-singleton
-- state store, which 6.0.1 hard-refuses under `NODE_ENV=production` for
-- multi-tenant deployments — process-shared state would leak across
-- resolved tenants. Without this table the registry init throws six
-- times (one per tenant) on a fresh Fly machine and every tenant route
-- returns 500 until first restart heals nothing.
--
-- This migration is the SDK-shipped DDL from `ADCP_STATE_MIGRATION`
-- (verbatim — do not edit). Wiring happens in
-- `server/src/training-agent/tenants/registry.ts` via
-- `new PostgresStateStore(getPool())`.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS).
-- Safe to re-run if the SDK's migration is bumped, with the caveat that
-- schema-widening changes will need their own follow-up migration.

CREATE TABLE IF NOT EXISTS adcp_state (
  collection    TEXT NOT NULL,
  id            TEXT NOT NULL,
  data          JSONB NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (collection, id)
);

ALTER TABLE adcp_state
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_adcp_state_collection
  ON adcp_state(collection);

CREATE INDEX IF NOT EXISTS idx_adcp_state_updated
  ON adcp_state(updated_at);
