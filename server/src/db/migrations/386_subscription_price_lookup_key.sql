-- Store the Stripe price lookup key so tier can be derived without an API call.
-- The lookup key (e.g., aao_membership_professional_250) is the authoritative
-- source for membership tier resolution.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_price_lookup_key TEXT;
