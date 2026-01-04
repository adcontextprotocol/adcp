-- Migration: 114_org_invoices_cache.sql
-- Cache Stripe invoice data locally to avoid API calls on every page load
-- Updated via Stripe webhooks: invoice.created, invoice.updated, invoice.finalized,
-- invoice.payment_succeeded, invoice.paid, invoice.voided

CREATE TABLE IF NOT EXISTS org_invoices (
  id SERIAL PRIMARY KEY,
  stripe_invoice_id VARCHAR(255) NOT NULL,
  stripe_customer_id VARCHAR(255) NOT NULL,
  workos_organization_id VARCHAR(255) REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,

  -- Invoice status: draft, open, paid, void, uncollectible
  status VARCHAR(50) NOT NULL,
  amount_due INTEGER NOT NULL DEFAULT 0, -- in cents
  amount_paid INTEGER NOT NULL DEFAULT 0, -- in cents
  currency VARCHAR(10) NOT NULL DEFAULT 'usd',

  -- Invoice details
  invoice_number VARCHAR(100),
  hosted_invoice_url TEXT,
  invoice_pdf TEXT,
  product_name VARCHAR(255),
  customer_email VARCHAR(255),

  -- Dates
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  due_date TIMESTAMP,
  paid_at TIMESTAMP,
  voided_at TIMESTAMP,

  -- Last sync from Stripe
  stripe_updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Unique constraint for Stripe invoice ID
  CONSTRAINT org_invoices_stripe_invoice_id_unique UNIQUE (stripe_invoice_id)
);

-- Index for looking up pending invoices by org
CREATE INDEX IF NOT EXISTS idx_org_invoices_org_pending
ON org_invoices(workos_organization_id, status)
WHERE status IN ('draft', 'open');

-- Index for looking up by Stripe customer
CREATE INDEX IF NOT EXISTS idx_org_invoices_customer
ON org_invoices(stripe_customer_id);

COMMENT ON TABLE org_invoices IS 'Cache of Stripe invoice data, synced via webhooks to avoid API calls';
