-- Migration: Add discount tracking fields to organizations
-- Allows admins to grant discounts (percentage or fixed amount) to organizations
-- and optionally create Stripe promotion codes for them

-- Discount tracking fields
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS discount_percent INTEGER;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS discount_amount_cents INTEGER;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS discount_reason TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS discount_granted_by VARCHAR(255);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS discount_granted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_coupon_id VARCHAR(255);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_promotion_code VARCHAR(255);

-- Comments for documentation
COMMENT ON COLUMN organizations.discount_percent IS 'Percentage discount (e.g., 20 = 20% off). Mutually exclusive with discount_amount_cents.';
COMMENT ON COLUMN organizations.discount_amount_cents IS 'Fixed dollar amount discount in cents. Mutually exclusive with discount_percent.';
COMMENT ON COLUMN organizations.discount_reason IS 'Reason why the discount was granted (e.g., startup, nonprofit, early adopter)';
COMMENT ON COLUMN organizations.discount_granted_by IS 'Name of the admin who granted the discount';
COMMENT ON COLUMN organizations.discount_granted_at IS 'When the discount was granted';
COMMENT ON COLUMN organizations.stripe_coupon_id IS 'Stripe coupon ID if a coupon was created for this org';
COMMENT ON COLUMN organizations.stripe_promotion_code IS 'Stripe promotion code that customers can enter at checkout';

-- Index for finding orgs with active discounts
CREATE INDEX IF NOT EXISTS idx_organizations_has_discount
ON organizations ((discount_percent IS NOT NULL OR discount_amount_cents IS NOT NULL));
