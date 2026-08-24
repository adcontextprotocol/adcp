-- One live Checkout session per organization. The immutable payload fingerprint keeps
-- Stripe idempotency keys from being reused with different parameters, while
-- the stored session lets safe retries resume an existing Checkout attempt.
CREATE TABLE IF NOT EXISTS membership_checkout_attempts (
  organization_id VARCHAR(255) PRIMARY KEY
    REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,
  payload_fingerprint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  initiated_by_user_id VARCHAR(255) NOT NULL,
  stripe_session_id TEXT,
  stripe_session_url TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_membership_checkout_attempts_expires_at
  ON membership_checkout_attempts(expires_at);
