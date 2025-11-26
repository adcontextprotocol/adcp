-- Migration: Simplify billing by using Stripe as source of truth
-- Remove redundant fields and use Stripe product SKU instead of custom tier

-- Remove fields that duplicate Stripe data
ALTER TABLE organizations
  DROP COLUMN IF EXISTS subscription_status,
  DROP COLUMN IF EXISTS subscription_tier,
  DROP COLUMN IF EXISTS stripe_subscription_id,
  DROP COLUMN IF EXISTS trial_end_date;

-- Organizations table now only stores:
-- - workos_organization_id (PK, links to WorkOS)
-- - name (cached from WorkOS for display)
-- - stripe_customer_id (reference to Stripe, nullable until they subscribe)
-- - agreement_signed_at (our legal requirement)
-- - agreement_version (our legal requirement)
-- - created_at, updated_at (audit trail)

-- Drop index on subscription_status since we removed it
DROP INDEX IF EXISTS idx_organizations_subscription_status;

-- Note: To get subscription info, query Stripe:
-- const customer = await stripe.customers.retrieve(stripe_customer_id, {
--   expand: ['subscriptions']
-- });
-- This gives you:
-- - subscription.status (active, past_due, canceled, etc.)
-- - subscription.items.data[0].price.product (Stripe product/SKU)
-- - subscription.current_period_end
-- - subscription.cancel_at_period_end
