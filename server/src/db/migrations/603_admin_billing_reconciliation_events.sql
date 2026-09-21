-- Append-only audit history for admin Stripe lookups and local refreshes.
-- Deliberately stores identifiers and state summaries only: no customer email,
-- payment method, hosted invoice URL, or other sensitive payment data.

CREATE TABLE IF NOT EXISTS admin_billing_reconciliation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('lookup', 'refresh')),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('stripe_customer', 'stripe_invoice')),
  resource_id TEXT NOT NULL,
  workos_organization_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'not_found', 'failed')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_billing_reconciliation_events_resource
  ON admin_billing_reconciliation_events(resource_type, resource_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_billing_reconciliation_events_actor
  ON admin_billing_reconciliation_events(actor_user_id, created_at DESC);

COMMENT ON TABLE admin_billing_reconciliation_events IS
  'Append-only, redacted audit events for admin Stripe lookup and local billing refresh actions.';
