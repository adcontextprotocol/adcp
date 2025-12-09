-- Migration: Add missing subscription columns
-- These columns are needed by the Stripe webhook handler

-- Add subscription_status column
ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50);

-- Add stripe_subscription_id column
ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);

-- Add index on subscription_status for filtering active subscriptions
CREATE INDEX IF NOT EXISTS idx_organizations_subscription_status
ON organizations(subscription_status)
WHERE subscription_status IS NOT NULL;

-- Add unique index on stripe_subscription_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_stripe_subscription_id
ON organizations(stripe_subscription_id)
WHERE stripe_subscription_id IS NOT NULL;
