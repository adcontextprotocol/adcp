-- Migration: 287_email_outreach.sql
-- Add email channel support to the outbound planner system.
-- Enables Addie to send proactive emails to prospects alongside Slack DMs.

-- ============================================================================
-- OUTREACH GOALS: add channel column
-- ============================================================================

ALTER TABLE outreach_goals
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'slack'
    CHECK (channel IN ('slack', 'email', 'any'));

CREATE INDEX idx_outreach_goals_channel ON outreach_goals(channel);

COMMENT ON COLUMN outreach_goals.channel IS 'Which channel this goal targets: slack (DM), email (outbound), or any (planner decides)';

-- ============================================================================
-- USER GOAL HISTORY: add channel tracking and email prospect support
-- ============================================================================

-- Channel used for this outreach attempt
ALTER TABLE user_goal_history
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'slack'
    CHECK (channel IN ('slack', 'email'));

-- For email-only prospects (no Slack presence), link to the organization
ALTER TABLE user_goal_history
  ADD COLUMN IF NOT EXISTS prospect_org_id TEXT
    REFERENCES organizations(workos_organization_id);

-- Store composed email content for auditability
ALTER TABLE user_goal_history
  ADD COLUMN IF NOT EXISTS email_subject TEXT;
ALTER TABLE user_goal_history
  ADD COLUMN IF NOT EXISTS email_body TEXT;

-- slack_user_id was NOT NULL — make it nullable for email-only prospects
ALTER TABLE user_goal_history
  ALTER COLUMN slack_user_id DROP NOT NULL;

-- Every record must have either a Slack user or a prospect org
ALTER TABLE user_goal_history
  ADD CONSTRAINT chk_goal_history_target
    CHECK (slack_user_id IS NOT NULL OR prospect_org_id IS NOT NULL);

CREATE INDEX idx_user_goal_history_channel ON user_goal_history(channel);
CREATE INDEX idx_user_goal_history_prospect_org ON user_goal_history(prospect_org_id)
  WHERE prospect_org_id IS NOT NULL;

-- ============================================================================
-- PROSPECT EMAIL OPT-OUTS
-- Separate from user_email_preferences because prospects aren't users yet.
-- Keyed on email address. Honored when prospect eventually signs up.
-- ============================================================================

CREATE TABLE IF NOT EXISTS prospect_email_optouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  unsubscribe_token TEXT NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'unsubscribe_link',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_prospect_email_optouts_email
  ON prospect_email_optouts(LOWER(email));
CREATE UNIQUE INDEX idx_prospect_email_optouts_token
  ON prospect_email_optouts(unsubscribe_token);

COMMENT ON TABLE prospect_email_optouts IS 'Tracks prospects who opted out of email outreach. Checked before sending and honored on sign-up.';

-- ============================================================================
-- ORGANIZATIONS: email outreach tracking columns
-- ============================================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS last_email_outreach_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_outreach_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_organizations_email_outreach
  ON organizations(last_email_outreach_at)
  WHERE prospect_owner = 'addie'
    AND prospect_contact_email IS NOT NULL;

-- ============================================================================
-- SEED: Membership Introduction email goal
-- ============================================================================

INSERT INTO outreach_goals (
  name, category, channel, description, success_insight_type,
  requires_mapped, base_priority, max_attempts, days_between_attempts,
  message_template, is_enabled, created_by
) VALUES (
  'Membership Introduction',
  'invitation',
  'email',
  'Introduce AgenticAdvertising.org to a prospect via email. Claude composes a personalized email based on company context.',
  'membership_interest',
  FALSE,
  70,
  3,    -- three-touch sequence
  4,    -- days between touches (Day 0, ~Day 4, ~Day 8)
  '',   -- no template — Claude composes each email
  TRUE,
  'system'
) ON CONFLICT DO NOTHING;

-- ============================================================================
-- UPDATE VIEW: include channel in goals summary
-- ============================================================================

CREATE OR REPLACE VIEW outreach_goals_summary AS
SELECT
  g.id,
  g.name,
  g.category,
  g.channel,
  g.description,
  g.base_priority,
  g.is_enabled,
  COUNT(DISTINCT o.id) AS outcome_count,
  COUNT(DISTINCT h.id) AS total_attempts,
  COUNT(DISTINCT h.id) FILTER (WHERE h.status = 'success') AS successful_attempts,
  ROUND(
    100.0 * COUNT(DISTINCT h.id) FILTER (WHERE h.status = 'success') /
    NULLIF(COUNT(DISTINCT h.id), 0),
    1
  ) AS success_rate_pct
FROM outreach_goals g
LEFT JOIN goal_outcomes o ON o.goal_id = g.id
LEFT JOIN user_goal_history h ON h.goal_id = g.id
GROUP BY g.id, g.name, g.category, g.channel, g.description, g.base_priority, g.is_enabled;
