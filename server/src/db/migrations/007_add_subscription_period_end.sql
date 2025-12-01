-- Migration: Add subscription_current_period_end to organizations table
-- This field is populated by Stripe webhooks to avoid repeated API calls

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMP WITH TIME ZONE;

-- Create index for querying subscriptions expiring soon
CREATE INDEX IF NOT EXISTS idx_organizations_period_end
  ON organizations(subscription_current_period_end)
  WHERE subscription_current_period_end IS NOT NULL;
