-- Migration: Comprehensive revenue tracking for membership dashboard
-- Captures all financial transactions, multi-product subscriptions, and revenue analytics

-- Revenue Events Table
-- Records all financial transactions (payments, refunds, one-time purchases)
CREATE TABLE IF NOT EXISTS revenue_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Organization linkage
  workos_organization_id VARCHAR(255) REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,

  -- Stripe references
  stripe_invoice_id VARCHAR(255) UNIQUE,
  stripe_subscription_id VARCHAR(255),
  stripe_payment_intent_id VARCHAR(255),
  stripe_charge_id VARCHAR(255),

  -- Revenue details
  amount_paid INTEGER NOT NULL, -- in cents, can be negative for refunds
  currency VARCHAR(3) DEFAULT 'usd',

  -- Classification
  revenue_type VARCHAR(50) NOT NULL, -- 'subscription_recurring', 'subscription_initial', 'one_time', 'refund'
  billing_reason VARCHAR(50), -- 'subscription_create', 'subscription_cycle', 'subscription_update', 'manual'

  -- Product/pricing info (cached from primary line item or most relevant product)
  product_id VARCHAR(255),
  product_name VARCHAR(255),
  price_id VARCHAR(255),
  billing_interval VARCHAR(20), -- 'month', 'year', null for one-time

  -- Timing
  paid_at TIMESTAMP WITH TIME ZONE NOT NULL,
  period_start TIMESTAMP WITH TIME ZONE,
  period_end TIMESTAMP WITH TIME ZONE,

  -- Flexible additional data
  metadata JSONB,

  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Subscription Line Items Table
-- Supports multi-product subscriptions (base plan + add-ons)
CREATE TABLE IF NOT EXISTS subscription_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Organization and subscription linkage
  workos_organization_id VARCHAR(255) REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,
  stripe_subscription_id VARCHAR(255) NOT NULL,
  stripe_subscription_item_id VARCHAR(255) UNIQUE NOT NULL,

  -- Price and product details
  price_id VARCHAR(255) NOT NULL,
  product_id VARCHAR(255),
  product_name VARCHAR(255),

  -- Quantity and amount
  quantity INTEGER DEFAULT 1,
  amount INTEGER, -- per unit in cents
  billing_interval VARCHAR(20), -- 'month', 'year'

  -- Usage-based billing support
  usage_type VARCHAR(50), -- 'licensed', 'metered'

  -- Flexible additional data
  metadata JSONB,

  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add subscription detail caching to organizations table
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS subscription_product_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS subscription_product_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS subscription_price_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS subscription_amount INTEGER, -- in cents
  ADD COLUMN IF NOT EXISTS subscription_currency VARCHAR(3) DEFAULT 'usd',
  ADD COLUMN IF NOT EXISTS subscription_interval VARCHAR(20), -- 'month', 'year'
  ADD COLUMN IF NOT EXISTS subscription_canceled_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS subscription_metadata JSONB;

-- Indexes for fast revenue queries
CREATE INDEX IF NOT EXISTS idx_revenue_events_organization ON revenue_events(workos_organization_id);
CREATE INDEX IF NOT EXISTS idx_revenue_events_paid_at ON revenue_events(paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_revenue_events_type ON revenue_events(revenue_type);
CREATE INDEX IF NOT EXISTS idx_revenue_events_subscription ON revenue_events(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_revenue_events_invoice ON revenue_events(stripe_invoice_id);

-- Indexes for subscription line items
CREATE INDEX IF NOT EXISTS idx_line_items_organization ON subscription_line_items(workos_organization_id);
CREATE INDEX IF NOT EXISTS idx_line_items_subscription ON subscription_line_items(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_line_items_price ON subscription_line_items(price_id);

-- Indexes for organization subscription details
CREATE INDEX IF NOT EXISTS idx_organizations_product ON organizations(subscription_product_id) WHERE subscription_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_organizations_interval ON organizations(subscription_interval) WHERE subscription_interval IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_organizations_canceled ON organizations(subscription_canceled_at) WHERE subscription_canceled_at IS NOT NULL;

-- Updated timestamp trigger for subscription_line_items
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'update_subscription_line_items_updated_at'
  ) THEN
    CREATE TRIGGER update_subscription_line_items_updated_at
      BEFORE UPDATE ON subscription_line_items
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
