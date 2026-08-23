-- SDK 14.0.0-beta.7 requires publisher-side webhook identity and the exact
-- retry snapshot to survive process crashes and replica changes.

CREATE TABLE IF NOT EXISTS adcp_webhook_delivery_bindings (
  publisher_scope TEXT NOT NULL,
  tenant_scope TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('bound', 'retired')),
  idempotency_key TEXT,
  payload_fingerprint TEXT,
  first_attempt_at TIMESTAMPTZ,
  retain_until TIMESTAMPTZ,
  PRIMARY KEY (publisher_scope, tenant_scope, delivery_id),
  CHECK (
    (status = 'bound'
      AND idempotency_key IS NOT NULL
      AND payload_fingerprint IS NOT NULL
      AND first_attempt_at IS NOT NULL
      AND retain_until IS NOT NULL)
    OR
    (status = 'retired'
      AND idempotency_key IS NULL
      AND payload_fingerprint IS NULL
      AND first_attempt_at IS NULL
      AND retain_until IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_adcp_webhook_delivery_binding_retention
  ON adcp_webhook_delivery_bindings(retain_until)
  WHERE status = 'bound';

CREATE TABLE IF NOT EXISTS adcp_webhook_delivery_outbox (
  publisher_scope TEXT NOT NULL,
  tenant_scope TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  snapshot_encrypted TEXT NOT NULL,
  snapshot_iv TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (publisher_scope, tenant_scope, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_adcp_webhook_delivery_outbox_pending
  ON adcp_webhook_delivery_outbox(next_attempt_at, lease_until, created_at);

COMMENT ON COLUMN adcp_webhook_delivery_outbox.snapshot_encrypted IS
  'AES-256-GCM encrypted exact WebhookDeliverySnapshot; may contain callback authentication credentials';
COMMENT ON COLUMN adcp_webhook_delivery_outbox.snapshot_digest IS
  'Keyed SHA-256 equality evidence; never a plaintext credential hash';
