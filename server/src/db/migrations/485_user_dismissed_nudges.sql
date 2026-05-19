-- Generic per-user dismissed-nudges state for in-app banners and prompts.
-- First consumer: brand-claim suggestion (#4744). Designed to be reusable
-- for future dashboard / viewer nudges without further schema churn.
--
-- nudge_key namespacing convention: `<feature>:<scope>`, e.g.
--   brand_claim_suggestion:scope3.com
--   onboarding:welcome
--
-- Re-dismissal updates dismissed_at — the 30-day re-surface cooldown is a
-- read-side concern (caller computes `NOW() - dismissed_at < interval`).
-- Storing only the latest dismissal keeps the table small and the read
-- query trivial.

CREATE TABLE IF NOT EXISTS user_dismissed_nudges (
  workos_user_id VARCHAR(255) NOT NULL,
  nudge_key      TEXT         NOT NULL,
  dismissed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workos_user_id, nudge_key)
);

-- Lookup by user is the only access pattern (dashboard load reads "what
-- did this user dismiss"). PK already covers it.
