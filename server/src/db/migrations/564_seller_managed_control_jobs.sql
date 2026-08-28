-- Migration 564: recoverable execution outbox for seller-managed control_media_buy jobs.
-- No FK to adcp_decisioning_tasks: the outbox is committed before SDK task
-- creation so a worker can recover a crash in that boundary.
CREATE TABLE IF NOT EXISTS seller_managed_control_jobs (
  task_id TEXT PRIMARY KEY,
  tool TEXT NOT NULL DEFAULT 'control_media_buy',
  account_id TEXT NOT NULL,
  owner_scope TEXT NOT NULL,
  idempotency_principal TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  media_buy_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1),
  authorized_actions JSONB NOT NULL CHECK (jsonb_typeof(authorized_actions) = 'array'),
  request JSONB NOT NULL,
  execution_context JSONB NOT NULL,
  push_config_encrypted TEXT,
  push_config_iv TEXT,
  has_webhook BOOLEAN NOT NULL DEFAULT FALSE,
  webhook_tenant_scope TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'working', 'succeeded', 'failed')),
  lease_owner TEXT,
  lease_version BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result JSONB,
  error JSONB,
  terminal_at TIMESTAMPTZ,
  task_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (idempotency_principal, account_id, idempotency_key),
  CHECK ((push_config_encrypted IS NULL) = (push_config_iv IS NULL)),
  CHECK (NOT has_webhook OR webhook_tenant_scope IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_seller_managed_control_jobs_recovery
  ON seller_managed_control_jobs (status, next_attempt_at, lease_expires_at)
  WHERE task_synced_at IS NULL;

COMMENT ON COLUMN seller_managed_control_jobs.push_config_encrypted IS
  'AES-256-GCM encrypted push_notification_config; may contain callback credentials';
COMMENT ON COLUMN seller_managed_control_jobs.request_fingerprint IS
  'Keyed canonical-request digest for principal/account idempotency arbitration';
COMMENT ON COLUMN seller_managed_control_jobs.webhook_tenant_scope IS
  'Exact trusted SDK webhook partition; required for recovery/framework deduplication';
