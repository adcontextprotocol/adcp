-- SDK 14.0.0-beta.7 separates logical replay expiry from the physical
-- retention boundary needed to honor the protocol clock-skew window.
ALTER TABLE adcp_idempotency
  ADD COLUMN IF NOT EXISTS retain_until TIMESTAMPTZ;

-- Existing rows predate the explicit boundary. Preserve the default 60-second
-- protocol clock-skew window rather than making them physically removable at
-- their logical expiry.
UPDATE adcp_idempotency
SET retain_until = expires_at + INTERVAL '60 seconds'
WHERE retain_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_adcp_idempotency_retain_until
  ON adcp_idempotency(retain_until, expires_at);
