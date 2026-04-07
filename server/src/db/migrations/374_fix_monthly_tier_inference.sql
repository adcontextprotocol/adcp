-- Fix membership tiers to match the product-based tier mapping.
--
-- The original thresholds were set at exact annual prices (e.g. $250 = 25 000¢),
-- which missed monthly subscriptions due to integer-cent rounding and placed
-- $10K founding corporate members into Builder instead of Partner.
--
-- Updated thresholds (annual cents):
--   individual_professional  >= 24 000  (was 25 000)  — catches $250/yr monthly
--   individual_academic      >=  4 500  (was  5 000)  — catches $50/yr monthly
--   company_leader           >= 4 900 000  (was 5 000 000) — catches $50K/yr monthly
--   company_icl              >= 700 000  (was 1 500 000)   — catches $10K founding corporate

UPDATE organizations
SET membership_tier = CASE
  WHEN is_personal AND (
    CASE WHEN subscription_interval = 'month' THEN subscription_amount * 12 ELSE subscription_amount END
  ) >= 24000 THEN 'individual_professional'
  WHEN is_personal AND (
    CASE WHEN subscription_interval = 'month' THEN subscription_amount * 12 ELSE subscription_amount END
  ) >= 4500 THEN 'individual_academic'
  WHEN NOT is_personal AND (
    CASE WHEN subscription_interval = 'month' THEN subscription_amount * 12 ELSE subscription_amount END
  ) >= 4900000 THEN 'company_leader'
  WHEN NOT is_personal AND (
    CASE WHEN subscription_interval = 'month' THEN subscription_amount * 12 ELSE subscription_amount END
  ) >= 700000 THEN 'company_icl'
  WHEN NOT is_personal THEN 'company_standard'
END
WHERE subscription_status = 'active'
  AND subscription_amount IS NOT NULL
  AND subscription_amount > 0
  AND membership_tier IS DISTINCT FROM (
    CASE
      WHEN is_personal AND (
        CASE WHEN subscription_interval = 'month' THEN subscription_amount * 12 ELSE subscription_amount END
      ) >= 24000 THEN 'individual_professional'
      WHEN is_personal AND (
        CASE WHEN subscription_interval = 'month' THEN subscription_amount * 12 ELSE subscription_amount END
      ) >= 4500 THEN 'individual_academic'
      WHEN NOT is_personal AND (
        CASE WHEN subscription_interval = 'month' THEN subscription_amount * 12 ELSE subscription_amount END
      ) >= 4900000 THEN 'company_leader'
      WHEN NOT is_personal AND (
        CASE WHEN subscription_interval = 'month' THEN subscription_amount * 12 ELSE subscription_amount END
      ) >= 700000 THEN 'company_icl'
      WHEN NOT is_personal THEN 'company_standard'
    END
  );
