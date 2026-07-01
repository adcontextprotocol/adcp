-- Postgres-backed task registry for the v6 DecisioningPlatform runtime.
--
-- The SDK's `createAdcpServerFromPlatform` defaults to an in-memory task
-- registry, which is process-local — buyer creates a media buy on Fly
-- machine A, polls status on machine B, sees "task not found". We're
-- multi-instance, so this fails ~50% of the time on any async/HITL flow.
--
-- This migration is the SDK-shipped DDL from
-- `getDecisioningTaskRegistryMigration()` (verbatim — do not edit). Wiring
-- happens in `server/src/training-agent/tenants/registry.ts` via
-- `createPostgresTaskRegistry({ pool: getPool() })`.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS); safe to re-run if the SDK's
-- migration is bumped, with the caveat that constraint widening (e.g. the
-- 6.1 status-state widening) will need its own follow-up migration when
-- the SDK ships it.

CREATE TABLE IF NOT EXISTS adcp_decisioning_tasks (
  task_id         TEXT PRIMARY KEY,
  tool            TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'submitted',
  status_message  TEXT,
  result          JSONB,
  error           JSONB,
  progress        JSONB,
  has_webhook     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT adcp_decisioning_tasks_valid_status CHECK (
    -- Framework-written values: 'submitted' (initial), 'working'
    -- (after first updateProgress() call), 'completed' / 'failed'
    -- (terminal). The other 5 spec-defined states ('input-required',
    -- 'canceled', 'rejected', 'auth-required', 'unknown') are reserved
    -- for adopter-emitted transitions via the v6.1
    -- `taskRegistry.transition()` API; the v6.1 migration will widen
    -- this CHECK.
    status IN ('submitted', 'working', 'completed', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_adcp_decisioning_tasks_account_id
  ON adcp_decisioning_tasks(account_id);

CREATE INDEX IF NOT EXISTS idx_adcp_decisioning_tasks_status_created
  ON adcp_decisioning_tasks(status, created_at);
