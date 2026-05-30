-- Shared preview state for Addie admin Stripe customer relinks.
-- Stored in Postgres so preview/confirm works across web machines and deploys.

CREATE TABLE IF NOT EXISTS admin_stripe_customer_update_previews (
  token UUID PRIMARY KEY,
  workos_organization_id TEXT NOT NULL,
  new_customer_id TEXT NOT NULL,
  current_customer_id TEXT,
  actor_workos_user_id TEXT NOT NULL,
  actor_email TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_stripe_customer_update_previews_expires
  ON admin_stripe_customer_update_previews(expires_at);
