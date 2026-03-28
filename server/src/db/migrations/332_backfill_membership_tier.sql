-- Backfill membership_tier for orgs that have active subscriptions but no tier set.
-- These are orgs created before migration 186 added the column, or where the signup
-- flow did not set the tier. Uses subscription_amount (in cents) to infer the tier.
-- Monthly amounts are stored per-interval, so annualize before comparing.

UPDATE organizations
SET membership_tier = CASE
  WHEN is_personal AND (
    CASE WHEN subscription_interval = 'month' THEN subscription_amount * 12 ELSE subscription_amount END
  ) >= 25000 THEN 'individual_professional'
  WHEN is_personal AND (
    CASE WHEN subscription_interval = 'month' THEN subscription_amount * 12 ELSE subscription_amount END
  ) >= 5000 THEN 'individual_academic'
  WHEN NOT is_personal AND (
    CASE WHEN subscription_interval = 'month' THEN subscription_amount * 12 ELSE subscription_amount END
  ) >= 5000000 THEN 'company_icl'
  WHEN NOT is_personal THEN 'company_standard'
END
WHERE membership_tier IS NULL
  AND subscription_status = 'active'
  AND subscription_amount IS NOT NULL
  AND subscription_amount > 0;
