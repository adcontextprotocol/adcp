-- Migration: 070_member_insights.sql
-- Member Insights and Proactive Engagement System
--
-- This creates:
-- 1. Insight types (admin-defined taxonomy)
-- 2. Member insights (what we know about each user)
-- 3. Insight goals (questions admins want Addie to explore)
-- 4. Outreach variants (A/B test configurations)
-- 5. Outreach test accounts (safe testing whitelist)
-- 6. Member outreach tracking (proactive conversation logs)

-- =====================================================
-- INSIGHT TYPES TABLE
-- =====================================================
-- Admin-defined taxonomy for categorizing member insights

CREATE TABLE IF NOT EXISTS member_insight_types (
  id SERIAL PRIMARY KEY,

  -- Type definition
  name VARCHAR(100) NOT NULL UNIQUE,        -- e.g., "role", "interest", "pain_point", "project"
  description TEXT,                          -- Admin explanation of this type
  example_values TEXT[],                     -- Sample values for reference

  -- Status
  is_active BOOLEAN DEFAULT TRUE,

  -- Audit
  created_by VARCHAR(255),                   -- WorkOS user ID
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index
CREATE INDEX IF NOT EXISTS idx_insight_types_active ON member_insight_types(is_active);

COMMENT ON TABLE member_insight_types IS 'Admin-defined taxonomy for categorizing member insights';
COMMENT ON COLUMN member_insight_types.name IS 'Unique identifier for the insight type (e.g., role, interest)';
COMMENT ON COLUMN member_insight_types.example_values IS 'Sample values to help admins understand this type';

-- =====================================================
-- MEMBER INSIGHTS TABLE
-- =====================================================
-- What we know about each user (gleaned from conversations or manually entered)

CREATE TABLE IF NOT EXISTS member_insights (
  id SERIAL PRIMARY KEY,

  -- Who the insight is about
  slack_user_id VARCHAR(255) NOT NULL,       -- Reference to slack_user_mappings
  workos_user_id VARCHAR(255),               -- If user is mapped to WorkOS

  -- The insight
  insight_type_id INTEGER NOT NULL REFERENCES member_insight_types(id),
  value TEXT NOT NULL,                       -- The actual insight value
  confidence VARCHAR(20) DEFAULT 'medium'    -- 'high', 'medium', 'low'
    CHECK (confidence IN ('high', 'medium', 'low')),

  -- Source tracking
  source_type VARCHAR(50) NOT NULL           -- 'conversation', 'observation', 'manual'
    CHECK (source_type IN ('conversation', 'observation', 'manual')),
  source_thread_id UUID,                     -- Reference to addie_threads if from conversation
  source_message_id UUID,                    -- Reference to addie_thread_messages
  extracted_from TEXT,                       -- The text snippet that revealed this

  -- Version tracking (when insights get updated)
  superseded_by INTEGER REFERENCES member_insights(id),  -- If updated with newer info
  is_current BOOLEAN DEFAULT TRUE,           -- Latest version of this insight type for user

  -- Audit
  created_by VARCHAR(255),                   -- For manual entries: WorkOS user ID
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_insights_slack_user ON member_insights(slack_user_id);
CREATE INDEX IF NOT EXISTS idx_insights_workos_user ON member_insights(workos_user_id) WHERE workos_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_insights_type ON member_insights(insight_type_id);
CREATE INDEX IF NOT EXISTS idx_insights_current ON member_insights(slack_user_id, insight_type_id) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_insights_source_thread ON member_insights(source_thread_id) WHERE source_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_insights_created ON member_insights(created_at DESC);

COMMENT ON TABLE member_insights IS 'Structured insights about members gleaned from conversations or manually entered';
COMMENT ON COLUMN member_insights.is_current IS 'TRUE if this is the latest value for this insight type for this user';
COMMENT ON COLUMN member_insights.superseded_by IS 'Points to newer insight that replaced this one';

-- =====================================================
-- INSIGHT GOALS TABLE
-- =====================================================
-- Questions/topics admins want Addie to explore with members

CREATE TABLE IF NOT EXISTS insight_goals (
  id SERIAL PRIMARY KEY,

  -- Goal definition
  name VARCHAR(200) NOT NULL,                -- Short name for admin reference
  question TEXT NOT NULL,                    -- The question Addie should ask/explore
  insight_type_id INTEGER REFERENCES member_insight_types(id),  -- Optional: map responses to a type

  -- Goal mode
  goal_type VARCHAR(20) NOT NULL DEFAULT 'persistent'
    CHECK (goal_type IN ('campaign', 'persistent')),

  -- Campaign mode: has start/end dates
  start_date DATE,
  end_date DATE,

  -- Persistent mode: enabled/disabled
  is_enabled BOOLEAN DEFAULT TRUE,

  -- Priority (for ordering when multiple goals apply)
  priority INTEGER DEFAULT 50,               -- Higher = more important (1-100)

  -- Targeting (optional)
  target_mapped_only BOOLEAN DEFAULT FALSE,  -- Only ask mapped users
  target_unmapped_only BOOLEAN DEFAULT FALSE,-- Only ask unmapped users

  -- Progress tracking
  target_response_count INTEGER,             -- Optional target
  current_response_count INTEGER DEFAULT 0,

  -- Dynamic prompt configuration (for suggested prompts)
  suggested_prompt_title VARCHAR(100),       -- Title shown in Slack suggested prompts
  suggested_prompt_message TEXT,             -- Message sent when user clicks prompt

  -- Audit
  created_by VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_goals_active ON insight_goals(is_enabled, goal_type);
CREATE INDEX IF NOT EXISTS idx_goals_campaign_dates ON insight_goals(start_date, end_date)
  WHERE goal_type = 'campaign';
CREATE INDEX IF NOT EXISTS idx_goals_priority ON insight_goals(priority DESC) WHERE is_enabled = TRUE;

COMMENT ON TABLE insight_goals IS 'Questions/topics admins want Addie to explore with members';
COMMENT ON COLUMN insight_goals.goal_type IS 'campaign = time-bounded, persistent = always active when enabled';
COMMENT ON COLUMN insight_goals.suggested_prompt_title IS 'Title for Slack suggested prompt (e.g., "Share your 2026 priorities")';

-- =====================================================
-- OUTREACH VARIANTS TABLE
-- =====================================================
-- A/B test configurations for proactive outreach messages

CREATE TABLE IF NOT EXISTS outreach_variants (
  id SERIAL PRIMARY KEY,

  -- Variant definition
  name VARCHAR(100) NOT NULL,                -- e.g., "Professional + Conversational"
  description TEXT,

  -- Style parameters
  tone VARCHAR(50) NOT NULL                  -- 'casual', 'professional', 'brief'
    CHECK (tone IN ('casual', 'professional', 'brief')),
  approach VARCHAR(50) NOT NULL              -- 'direct', 'conversational', 'minimal'
    CHECK (approach IN ('direct', 'conversational', 'minimal')),

  -- Message template (with placeholders like {{user_name}}, {{goal_question}})
  message_template TEXT NOT NULL,

  -- A/B test weighting
  is_active BOOLEAN DEFAULT TRUE,
  weight INTEGER DEFAULT 100,                -- For weighted random selection

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index
CREATE INDEX IF NOT EXISTS idx_variants_active ON outreach_variants(is_active);

COMMENT ON TABLE outreach_variants IS 'A/B test configurations for proactive outreach message styles';
COMMENT ON COLUMN outreach_variants.weight IS 'Relative weight for random selection (higher = more likely)';

-- =====================================================
-- OUTREACH TEST ACCOUNTS TABLE
-- =====================================================
-- Whitelist of accounts for safe testing (when OUTREACH_MODE=test)

CREATE TABLE IF NOT EXISTS outreach_test_accounts (
  id SERIAL PRIMARY KEY,

  slack_user_id VARCHAR(255) NOT NULL UNIQUE,
  description VARCHAR(255),                  -- e.g., "Brian's test account"

  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE outreach_test_accounts IS 'Whitelist of Slack accounts for safe outreach testing';

-- =====================================================
-- MEMBER OUTREACH TABLE
-- =====================================================
-- Tracks proactive outreach attempts and outcomes

CREATE TABLE IF NOT EXISTS member_outreach (
  id SERIAL PRIMARY KEY,

  -- Who was contacted
  slack_user_id VARCHAR(255) NOT NULL,

  -- What type of outreach
  outreach_type VARCHAR(50) NOT NULL         -- 'account_link', 'introduction', 'insight_goal', 'custom'
    CHECK (outreach_type IN ('account_link', 'introduction', 'insight_goal', 'custom')),
  insight_goal_id INTEGER REFERENCES insight_goals(id),  -- If related to a goal

  -- The conversation
  thread_id UUID REFERENCES addie_threads(thread_id),
  dm_channel_id VARCHAR(255),                -- Slack DM channel
  initial_message TEXT,                      -- What Addie sent

  -- A/B testing
  variant_id INTEGER REFERENCES outreach_variants(id),
  tone VARCHAR(50),                          -- Denormalized for analysis
  approach VARCHAR(50),                      -- Denormalized for analysis

  -- Outcome
  user_responded BOOLEAN DEFAULT FALSE,
  response_received_at TIMESTAMP WITH TIME ZONE,
  insight_extracted BOOLEAN DEFAULT FALSE,   -- Did we get useful info?

  -- Timestamps
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_outreach_slack_user ON member_outreach(slack_user_id);
CREATE INDEX IF NOT EXISTS idx_outreach_sent ON member_outreach(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_goal ON member_outreach(insight_goal_id) WHERE insight_goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outreach_variant ON member_outreach(variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outreach_responded ON member_outreach(user_responded, sent_at);

COMMENT ON TABLE member_outreach IS 'Tracks proactive outreach attempts and their outcomes';
COMMENT ON COLUMN member_outreach.tone IS 'Denormalized from variant for easier analysis';

-- =====================================================
-- ALTER SLACK_USER_MAPPINGS
-- =====================================================
-- Add outreach tracking columns

ALTER TABLE slack_user_mappings
ADD COLUMN IF NOT EXISTS last_outreach_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS outreach_opt_out BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS outreach_opt_out_at TIMESTAMP WITH TIME ZONE;

-- Index for outreach targeting
CREATE INDEX IF NOT EXISTS idx_slack_mapping_outreach_eligible ON slack_user_mappings(last_outreach_at)
  WHERE slack_is_bot = FALSE
    AND slack_is_deleted = FALSE
    AND outreach_opt_out = FALSE;

-- =====================================================
-- SEED DEFAULT INSIGHT TYPES
-- =====================================================

INSERT INTO member_insight_types (name, description, example_values, created_by)
VALUES
  ('role', 'The person''s role or job function', ARRAY['Publisher', 'Advertiser', 'Agency', 'Ad Tech Vendor', 'Developer', 'Product Manager', 'Executive'], 'system'),
  ('building', 'What they are building or working on', ARRAY['Sales agent', 'Buyer agent', 'Creative agent', 'SSP integration', 'DSP integration'], 'system'),
  ('interest', 'Topics or areas they are interested in', ARRAY['Sustainability', 'AI/ML', 'Privacy', 'Identity', 'Measurement', 'Creative optimization'], 'system'),
  ('pain_point', 'Challenges or problems they face', ARRAY['Integration complexity', 'Lack of transparency', 'High latency', 'Data silos'], 'system'),
  ('company_focus', 'What their company does in ad tech', ARRAY['Supply side', 'Demand side', 'Data provider', 'Measurement', 'Creative', 'Full stack'], 'system'),
  ('aao_goals', 'What they want from AgenticAdvertising.org', ARRAY['Networking', 'Protocol development', 'Standards influence', 'Implementation support'], 'system')
ON CONFLICT (name) DO NOTHING;

-- =====================================================
-- SEED DEFAULT OUTREACH VARIANTS
-- =====================================================

INSERT INTO outreach_variants (name, tone, approach, message_template, weight)
VALUES
  (
    'Professional + Conversational',
    'professional',
    'conversational',
    E'Hi there! I''m Addie, the AI assistant for AgenticAdvertising.org.\n\nI noticed you''re part of the Slack community but haven''t linked your account yet. Linking gives you access to your member profile, working groups, and personalized help from me.\n\nWould you like me to send you a quick link to get set up? It only takes a minute!',
    100
  ),
  (
    'Casual + Direct',
    'casual',
    'direct',
    E'Hey! I''m Addie from AAO.\n\nQuick question - want to link your Slack to your member account? Takes 30 seconds and unlocks your profile, working groups, and personalized help.\n\nJust say the word and I''ll send the link!',
    100
  ),
  (
    'Brief + Minimal',
    'brief',
    'minimal',
    E'Hi, I''m Addie (AAO''s AI assistant).\n\nI can help you link your Slack account to get full member access. Would that be helpful?',
    100
  )
ON CONFLICT DO NOTHING;

-- =====================================================
-- VIEWS FOR ANALYTICS
-- =====================================================

-- Member insight summary view
CREATE OR REPLACE VIEW member_insight_summary AS
SELECT
  m.slack_user_id,
  m.slack_email,
  m.slack_real_name,
  m.slack_display_name,
  m.workos_user_id,
  m.mapping_status,
  COUNT(DISTINCT i.id) FILTER (WHERE i.is_current) as insight_count,
  MAX(i.created_at) as last_insight_at,
  ARRAY_AGG(DISTINCT t.name) FILTER (WHERE i.is_current) as insight_types
FROM slack_user_mappings m
LEFT JOIN member_insights i ON m.slack_user_id = i.slack_user_id
LEFT JOIN member_insight_types t ON i.insight_type_id = t.id
WHERE m.slack_is_bot = FALSE AND m.slack_is_deleted = FALSE
GROUP BY m.slack_user_id, m.slack_email, m.slack_real_name, m.slack_display_name, m.workos_user_id, m.mapping_status;

-- Outreach effectiveness view
CREATE OR REPLACE VIEW outreach_variant_stats AS
SELECT
  v.id as variant_id,
  v.name as variant_name,
  v.tone,
  v.approach,
  COUNT(o.id) as total_sent,
  COUNT(o.id) FILTER (WHERE o.user_responded) as total_responded,
  COUNT(o.id) FILTER (WHERE o.insight_extracted) as total_insights,
  ROUND(
    100.0 * COUNT(o.id) FILTER (WHERE o.user_responded) / NULLIF(COUNT(o.id), 0),
    1
  ) as response_rate_pct,
  ROUND(
    100.0 * COUNT(o.id) FILTER (WHERE o.insight_extracted) / NULLIF(COUNT(o.id) FILTER (WHERE o.user_responded), 0),
    1
  ) as insight_rate_pct
FROM outreach_variants v
LEFT JOIN member_outreach o ON v.id = o.variant_id
GROUP BY v.id, v.name, v.tone, v.approach;

-- Goal progress view
CREATE OR REPLACE VIEW insight_goal_progress AS
SELECT
  g.id,
  g.name,
  g.question,
  g.goal_type,
  g.is_enabled,
  g.start_date,
  g.end_date,
  g.priority,
  g.target_response_count,
  g.current_response_count,
  ROUND(
    100.0 * g.current_response_count / NULLIF(g.target_response_count, 0),
    1
  ) as progress_pct,
  CASE
    WHEN g.goal_type = 'campaign' AND g.end_date < CURRENT_DATE THEN 'expired'
    WHEN g.goal_type = 'campaign' AND g.start_date > CURRENT_DATE THEN 'scheduled'
    WHEN g.is_enabled THEN 'active'
    ELSE 'disabled'
  END as status
FROM insight_goals g;

COMMENT ON VIEW member_insight_summary IS 'Summary of insights per member for admin dashboard';
COMMENT ON VIEW outreach_variant_stats IS 'A/B test statistics for outreach message variants';
COMMENT ON VIEW insight_goal_progress IS 'Progress tracking for insight goals';
