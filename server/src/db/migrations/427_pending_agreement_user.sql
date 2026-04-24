-- Record which WorkOS user clicked the membership-agreement checkbox, so the
-- Stripe customer.subscription.created webhook can attribute the user-level
-- acceptance deterministically instead of reverse-looking-up via
-- stripe_customer.email → WorkOS.
--
-- Companion to migration 006 which added pending_agreement_version and
-- pending_agreement_accepted_at. Email-based resolution was the silent-failure
-- bug traced in PR #3011; capturing the user at checkbox time removes the
-- fallback requirement.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pending_agreement_user_id VARCHAR(255);

COMMENT ON COLUMN organizations.pending_agreement_user_id IS 'WorkOS user ID of the person who clicked the agreement checkbox. Cleared when the agreement is recorded permanently.';
