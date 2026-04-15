-- Store marketing opt-in preference for Slack users who respond to the DM
-- before being mapped to a web account. Applied when mapping occurs.
ALTER TABLE slack_user_mappings
  ADD COLUMN IF NOT EXISTS pending_marketing_opt_in BOOLEAN,
  ADD COLUMN IF NOT EXISTS pending_marketing_opt_in_at TIMESTAMP WITH TIME ZONE;
