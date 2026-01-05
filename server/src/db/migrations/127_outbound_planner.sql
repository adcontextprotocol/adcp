-- Migration: 127_outbound_planner.sql
-- Adaptive Outbound Planner - intelligent goal selection based on user context
--
-- This replaces rigid sequences with adaptive goal selection:
-- 1. Goals have eligibility criteria (company type, engagement level, required insights)
-- 2. Planner uses rules + LLM to select best goal for each user
-- 3. Outcomes define what happens based on user responses
-- 4. History tracks what we've tried with each user

-- ============================================================================
-- GOAL REGISTRY - What's possible to pursue with members
-- ============================================================================

CREATE TABLE outreach_goals (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  category VARCHAR(50) NOT NULL CHECK (category IN (
    'information',   -- Gather info about the user
    'education',     -- Explain something to them
    'invitation',    -- Invite to council, working group, event
    'connection',    -- Introduce to relevant people
    'admin'          -- Administrative tasks (link account, update profile)
  )),

  -- What this goal achieves
  description TEXT,
  success_insight_type VARCHAR(100),  -- What insight we gain on success (FK to member_insight_types.name)

  -- Eligibility criteria (who can we pursue this with?)
  requires_mapped BOOLEAN DEFAULT FALSE,
  requires_company_type VARCHAR(50)[] DEFAULT '{}',  -- ['publisher', 'dsp'] or empty for any
  requires_min_engagement INTEGER DEFAULT 0,  -- 0-100 engagement score threshold
  requires_insights JSONB DEFAULT '{}',  -- {"role": "any"} = must have role insight
  excludes_insights JSONB DEFAULT '{}',  -- {"goals_2025": "any"} = skip if already known

  -- Priority/Weight
  base_priority INTEGER DEFAULT 50 CHECK (base_priority BETWEEN 1 AND 100),

  -- Message templates
  message_template TEXT NOT NULL,
  follow_up_on_question TEXT,  -- What to say if they ask "what's that?"

  -- Status
  is_enabled BOOLEAN DEFAULT TRUE,

  -- Audit
  created_by VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_outreach_goals_enabled ON outreach_goals(is_enabled) WHERE is_enabled = TRUE;
CREATE INDEX idx_outreach_goals_category ON outreach_goals(category);

COMMENT ON TABLE outreach_goals IS 'Registry of possible goals to pursue with members. Planner selects best goal based on context.';
COMMENT ON COLUMN outreach_goals.requires_insights IS 'JSON object where keys are insight types and values are "any" or specific value pattern';
COMMENT ON COLUMN outreach_goals.excludes_insights IS 'Skip this goal if user already has these insights';


-- ============================================================================
-- GOAL OUTCOMES - What happens based on user responses
-- ============================================================================

CREATE TABLE goal_outcomes (
  id SERIAL PRIMARY KEY,
  goal_id INTEGER NOT NULL REFERENCES outreach_goals(id) ON DELETE CASCADE,

  -- Trigger condition
  trigger_type VARCHAR(50) NOT NULL CHECK (trigger_type IN (
    'sentiment',    -- Based on response sentiment (positive, negative, neutral, refusal)
    'intent',       -- Based on response intent (converted, interested, deferred, question, objection, refusal)
    'keyword',      -- Contains specific keywords (comma-separated)
    'timeout',      -- No response within N hours
    'default'       -- Fallback if nothing else matches
  )),
  trigger_value TEXT,  -- Depends on trigger_type

  -- Result classification
  outcome_type VARCHAR(50) NOT NULL CHECK (outcome_type IN (
    'success',      -- Goal achieved
    'defer',        -- Try again later
    'clarify',      -- Send clarification, then retry
    'decline',      -- User not interested
    'escalate'      -- Needs human review
  )),

  -- Actions to take
  response_message TEXT,  -- Immediate response if needed
  next_goal_id INTEGER REFERENCES outreach_goals(id),  -- Suggest next goal to pursue
  defer_days INTEGER,  -- When to try again (for defer outcome)
  insight_to_record VARCHAR(100),  -- What insight this gives us
  insight_value TEXT,  -- Value to record for the insight

  -- Priority (for multiple matching outcomes)
  priority INTEGER DEFAULT 50,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_goal_outcomes_goal ON goal_outcomes(goal_id);

COMMENT ON TABLE goal_outcomes IS 'Defines what happens when user responds to a goal. Multiple outcomes per goal, matched by trigger.';


-- ============================================================================
-- USER GOAL HISTORY - What we've tried with each user
-- ============================================================================

CREATE TABLE user_goal_history (
  id SERIAL PRIMARY KEY,
  slack_user_id VARCHAR(255) NOT NULL,
  goal_id INTEGER NOT NULL REFERENCES outreach_goals(id),

  -- Status
  status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',      -- Scheduled but not sent
    'sent',         -- Message sent, awaiting response
    'responded',    -- User responded, processing
    'success',      -- Goal achieved
    'declined',     -- User not interested
    'deferred'      -- Will retry later
  )),

  -- Attempt tracking
  attempt_count INTEGER DEFAULT 0,
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  next_attempt_at TIMESTAMP WITH TIME ZONE,

  -- Response data
  outcome_id INTEGER REFERENCES goal_outcomes(id),
  response_text TEXT,
  response_sentiment VARCHAR(50),
  response_intent VARCHAR(50),

  -- Planner decision context (why was this goal selected?)
  planner_reason TEXT,
  planner_score INTEGER,
  decision_method VARCHAR(20),  -- 'rule_match' or 'llm'

  -- Links to existing tables
  outreach_id INTEGER REFERENCES member_outreach(id),
  thread_id UUID REFERENCES addie_threads(thread_id),

  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_user_goal_history_user ON user_goal_history(slack_user_id);
CREATE INDEX idx_user_goal_history_status ON user_goal_history(status);
CREATE INDEX idx_user_goal_history_next_attempt ON user_goal_history(next_attempt_at)
  WHERE status = 'deferred' AND next_attempt_at IS NOT NULL;

COMMENT ON TABLE user_goal_history IS 'Tracks all goal attempts with each user. Prevents re-asking recently asked questions.';


-- ============================================================================
-- REHEARSAL SESSIONS - Practice conversations before going live
-- ============================================================================

CREATE TABLE rehearsal_sessions (
  id SERIAL PRIMARY KEY,

  -- Admin running the rehearsal
  admin_user_id VARCHAR(255) NOT NULL,

  -- Simulated persona
  persona_name VARCHAR(200),
  persona_context JSONB DEFAULT '{}',  -- Custom context: role, company_type, insights, etc.

  -- Current state
  current_goal_id INTEGER REFERENCES outreach_goals(id),
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),

  -- Conversation history stored as JSON array
  messages JSONB DEFAULT '[]',  -- [{role, content, analysis?, outcome?, timestamp}]

  -- Session notes
  notes TEXT,
  outcome_summary VARCHAR(200),

  -- Timestamps
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ended_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_rehearsal_sessions_admin ON rehearsal_sessions(admin_user_id);
CREATE INDEX idx_rehearsal_sessions_status ON rehearsal_sessions(status);

COMMENT ON TABLE rehearsal_sessions IS 'Practice conversations with simulated personas. Does not affect production metrics.';


-- ============================================================================
-- EXTEND ADDIE_THREADS - Mark rehearsal threads
-- ============================================================================

ALTER TABLE addie_threads
ADD COLUMN IF NOT EXISTS is_rehearsal BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS rehearsal_session_id INTEGER REFERENCES rehearsal_sessions(id);

CREATE INDEX idx_addie_threads_rehearsal ON addie_threads(is_rehearsal) WHERE is_rehearsal = TRUE;

COMMENT ON COLUMN addie_threads.is_rehearsal IS 'TRUE for rehearsal threads - excluded from production metrics';


-- ============================================================================
-- SEED DATA - Initial goals based on common outreach patterns
-- ============================================================================

INSERT INTO outreach_goals (name, category, description, success_insight_type, requires_mapped, message_template, follow_up_on_question, base_priority, created_by)
VALUES
  -- Admin goals
  (
    'Link Account',
    'admin',
    'Get user to connect their Slack account to their web account',
    NULL,
    FALSE,  -- Specifically for unmapped users
    E'{{user_name}} - I''m reaching out to {{company_name}} team members who haven''t connected their Slack and web accounts yet.\n\nRight now you have a Slack account with us. Clicking this link will connect it to your agenticadvertising.org web account:\n\n{{link_url}}\n\nOnce connected, you''ll be able to access working group resources, vote in governance, and appear correctly in the member directory.\n\nMost people complete it in under a minute.',
    E'Linking your accounts means you can access the full member experience - working group materials, voting, your personalized dashboard, and the member directory. It''s a one-click process that uses your existing Slack identity.',
    90,  -- High priority for unmapped users
    'system'
  ),

  -- Information gathering goals
  (
    'Learn Role',
    'information',
    'Understand the user''s role and responsibilities',
    'role',
    TRUE,
    E'{{user_name}} - To help you get the most out of your membership, I''d love to know more about your role at {{company_name}}.\n\nAre you more on the technical side, business side, or leadership? This helps me point you to the right resources and connections.',
    E'I ask because different roles get value from different parts of the organization. Technical folks often love our working groups. Business leaders find the councils valuable. Leadership tends to engage with governance and strategic initiatives.',
    70,
    'system'
  ),
  (
    'Learn 2025/2026 Goals',
    'information',
    'Understand what the user/company wants to achieve this year',
    'goals_2025',
    TRUE,
    E'{{user_name}} - I''m curious what {{company_name}} is focused on for agentic advertising this year.\n\nWhat are you hoping to accomplish with AgenticAdvertising.org?',
    E'I''m asking because it helps me connect you with the right resources and people. For example, if you''re focused on sustainability, I can point you to our Sustainability Council. If you''re working on measurement challenges, our Measurement Working Group might be valuable.',
    65,
    'system'
  ),
  (
    'Learn Interests',
    'information',
    'Understand what topics/areas the user is interested in',
    'interests',
    TRUE,
    E'{{user_name}} - We have several focus areas at AgenticAdvertising.org: sustainability, open web, measurement & attribution, privacy, and AI/agents.\n\nWhich of these resonate most with what you''re working on?',
    E'These map to our working groups and councils. Sustainability is our most active council. Open web focuses on publisher concerns. Measurement tackles attribution challenges. Knowing your interests helps me make better recommendations.',
    60,
    'system'
  ),

  -- Education goals
  (
    'Explain Industry Councils',
    'education',
    'Help user understand what industry councils are and how they work',
    NULL,
    TRUE,
    E'{{user_name}} - You might be interested in our Industry Councils. These are member-led groups focused on specific verticals like publishing, retail media, and sustainability.\n\nCouncils meet regularly to share challenges, develop best practices, and collaborate on industry initiatives. Members often say it''s one of the most valuable parts of their membership.\n\nWould you like to know more about any specific council?',
    NULL,
    50,
    'system'
  ),
  (
    'Explain Working Groups',
    'education',
    'Help user understand what working groups are',
    NULL,
    TRUE,
    E'{{user_name}} - Our Working Groups are where the technical work happens. They focus on specific challenges like measurement, identity, and protocol development.\n\nUnlike councils (which are industry-focused), working groups are topic-focused and produce concrete outputs: specifications, best practices, reference implementations.\n\nWant me to tell you about the active working groups?',
    NULL,
    50,
    'system'
  ),

  -- Invitation goals
  (
    'Invite to Open Web Council',
    'invitation',
    'Invite publisher contacts to the Open Web Council',
    'council_interest',
    TRUE,
    E'{{user_name}} - Based on {{company_name}}''s work in publishing, you might be interested in our Open Web Council.\n\nIt''s a group of publishers working together on the challenges of the open web - monetization, sustainability, and maintaining independence from walled gardens.\n\nWould you like me to share more about what they''re working on?',
    E'The Open Web Council meets monthly to discuss shared challenges. Recent topics include sustainable advertising models, combating MFA sites, and building direct brand relationships. It''s a space for publishers to collaborate rather than compete.',
    55,
    'system'
  ),
  (
    'Invite to Sustainability Council',
    'invitation',
    'Invite sustainability-focused contacts to the Sustainability Council',
    'council_interest',
    TRUE,
    E'{{user_name}} - Given your interest in sustainability, our Sustainability Council might be valuable.\n\nIt''s focused on reducing the environmental impact of digital advertising - carbon measurement, supply path optimization for emissions, and sustainable practices.\n\nThey''re doing some interesting work. Want me to tell you more?',
    E'The council includes brands, agencies, ad tech companies, and publishers all working on the same challenge. They''ve developed frameworks for measuring ad carbon, best practices for sustainable campaigns, and are working on industry-wide standards.',
    55,
    'system'
  )
ON CONFLICT DO NOTHING;


-- ============================================================================
-- SEED OUTCOMES - Common response patterns
-- ============================================================================

-- Link Account outcomes
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, defer_days, insight_to_record, priority)
SELECT
  g.id,
  'intent',
  'converted',
  'success',
  NULL,  -- No response needed, they clicked the link
  NULL,
  NULL,
  100
FROM outreach_goals g WHERE g.name = 'Link Account';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, defer_days, priority)
SELECT
  g.id,
  'intent',
  'question',
  'clarify',
  NULL,  -- Use follow_up_on_question from goal
  NULL,
  90
FROM outreach_goals g WHERE g.name = 'Link Account';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT
  g.id,
  'intent',
  'deferred',
  'defer',
  7,  -- Try again in 7 days
  80
FROM outreach_goals g WHERE g.name = 'Link Account';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, priority)
SELECT
  g.id,
  'sentiment',
  'refusal',
  'decline',
  70
FROM outreach_goals g WHERE g.name = 'Link Account';

-- Learn Role outcomes
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, insight_to_record, priority)
SELECT
  g.id,
  'sentiment',
  'positive',
  'success',
  'role',
  100
FROM outreach_goals g WHERE g.name = 'Learn Role';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT
  g.id,
  'intent',
  'deferred',
  'defer',
  14,
  80
FROM outreach_goals g WHERE g.name = 'Learn Role';

-- Learn 2025/2026 Goals outcomes
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, insight_to_record, priority)
SELECT
  g.id,
  'sentiment',
  'positive',
  'success',
  'goals_2025',
  100
FROM outreach_goals g WHERE g.name = 'Learn 2025/2026 Goals';

-- Default outcomes for all goals (fallback)
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT
  g.id,
  'timeout',
  '168',  -- 7 days in hours
  'defer',
  14,
  10  -- Low priority fallback
FROM outreach_goals g;

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, priority)
SELECT
  g.id,
  'default',
  NULL,
  'escalate',
  1  -- Lowest priority - only if nothing else matches
FROM outreach_goals g;


-- ============================================================================
-- UPDATE FUNCTION - Timestamp trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION update_outreach_goals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outreach_goals_updated_at
  BEFORE UPDATE ON outreach_goals
  FOR EACH ROW
  EXECUTE FUNCTION update_outreach_goals_updated_at();

CREATE OR REPLACE FUNCTION update_user_goal_history_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_goal_history_updated_at
  BEFORE UPDATE ON user_goal_history
  FOR EACH ROW
  EXECUTE FUNCTION update_user_goal_history_updated_at();


-- ============================================================================
-- VIEWS - Useful queries
-- ============================================================================

-- Active goals with outcome counts
CREATE OR REPLACE VIEW outreach_goals_summary AS
SELECT
  g.id,
  g.name,
  g.category,
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
GROUP BY g.id, g.name, g.category, g.description, g.base_priority, g.is_enabled;

-- Users ready for next outreach
CREATE OR REPLACE VIEW users_ready_for_outreach AS
SELECT
  s.slack_user_id,
  s.slack_display_name AS slack_user_name,
  s.workos_user_id,
  o.name AS company_name,
  o.company_types[1] AS company_type,
  0 AS engagement_score,  -- TODO: Add engagement calculation later
  MAX(mo.sent_at) AS last_outreach_at,
  COUNT(DISTINCT h.id) FILTER (WHERE h.status = 'success') AS goals_completed,
  COUNT(DISTINCT h.id) FILTER (WHERE h.status IN ('pending', 'sent')) AS goals_in_progress
FROM slack_user_mappings s
LEFT JOIN organization_memberships om ON om.workos_user_id = s.workos_user_id
LEFT JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
LEFT JOIN member_outreach mo ON mo.slack_user_id = s.slack_user_id
LEFT JOIN user_goal_history h ON h.slack_user_id = s.slack_user_id
WHERE NOT EXISTS (
  -- No recent outreach
  SELECT 1 FROM member_outreach mo2
  WHERE mo2.slack_user_id = s.slack_user_id
  AND mo2.sent_at > NOW() - INTERVAL '7 days'
)
AND NOT EXISTS (
  -- No pending/in-progress goals
  SELECT 1 FROM user_goal_history h2
  WHERE h2.slack_user_id = s.slack_user_id
  AND h2.status IN ('pending', 'sent')
)
AND s.outreach_opt_out IS NOT TRUE
GROUP BY s.slack_user_id, s.slack_display_name, s.workos_user_id, o.name, o.company_types;

COMMENT ON VIEW users_ready_for_outreach IS 'Users who can be contacted - no recent outreach and no pending goals';
