-- Migration: 076_unified_contacts_view.sql
-- Unified view of all contacts (users, Slack-only, email-only)
-- with dynamic goal selection for Addie
--
-- This creates:
-- 1. A unified contacts view combining all identity sources
-- 2. Goal selection function based on engagement/excitement/status
-- 3. Activity summary for contacts without full user accounts

-- =====================================================
-- GOAL TYPES ENUM-LIKE TABLE
-- =====================================================
-- Define the possible goal types and their priorities

CREATE TABLE IF NOT EXISTS addie_goal_types (
  id SERIAL PRIMARY KEY,
  goal_key VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 50,  -- Higher = more important
  prompt_template TEXT,  -- What Addie should say/do
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed the goal types based on our strategy
INSERT INTO addie_goal_types (goal_key, name, description, priority, prompt_template)
VALUES
  ('link_account', 'Link Account',
   'Help user link their Slack to their AAO account',
   100,
   'Help the user connect their Slack account to their AgenticAdvertising.org profile. This unlocks their member benefits, working group access, and personalized assistance.'),

  ('membership_pitch', 'Membership Pitch',
   'Encourage upgrade to paid membership (high engagement or excitement)',
   90,
   'The user shows strong interest in agentic advertising. Explore whether they or their organization might benefit from paid membership, which includes deeper protocol access, working group participation, and direct support.'),

  ('drive_engagement', 'Drive Engagement',
   'Increase engagement for low-activity users',
   70,
   'Help the user get more value from AAO. Suggest relevant working groups, upcoming events, or content that matches their interests. Learn what would make their membership more valuable.'),

  ('drive_value', 'Drive Value',
   'Help paying members get more from their membership',
   80,
   'This is a paying member with low engagement. Help them discover features they might not be using, connect them with relevant working groups, or understand what would make their membership more valuable.'),

  ('learn_interests', 'Learn Interests',
   'Discover what the user cares about and is working on',
   60,
   'Learn more about what this person is working on, their company''s plans for agentic advertising, and what they hope to get from AAO. This helps us serve them better.'),

  ('deepen_relationship', 'Deepen Relationship',
   'Engaged users - seek referrals and strategic input',
   50,
   'This is an engaged member. Seek their input on AAO direction, ask for referrals to others who should join, and explore how we can support their work.'),

  ('initial_contact', 'Initial Contact',
   'First interaction with a new contact',
   40,
   'This is a new contact. Introduce yourself, learn who they are and what brought them to AAO, and help them get oriented.')
ON CONFLICT (goal_key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  priority = EXCLUDED.priority,
  prompt_template = EXCLUDED.prompt_template;

COMMENT ON TABLE addie_goal_types IS 'Defines the goal types Addie can pursue with contacts';

-- Index for efficient goal lookup
CREATE INDEX IF NOT EXISTS idx_addie_goal_types_key_active
  ON addie_goal_types(goal_key) WHERE is_active = TRUE;

-- =====================================================
-- DYNAMIC GOAL SELECTION FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION select_addie_goal(
  p_has_workos_account BOOLEAN,
  p_is_slack_mapped BOOLEAN,
  p_engagement_score INTEGER,
  p_excitement_score INTEGER,
  p_is_paying BOOLEAN,
  p_last_conversation_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
) RETURNS TABLE (
  goal_key VARCHAR(50),
  goal_name VARCHAR(100),
  priority INTEGER,
  prompt_template TEXT,
  reasoning TEXT
) AS $$
BEGIN
  -- Priority 1: Link account (has Slack but not mapped)
  IF p_has_workos_account = FALSE AND p_is_slack_mapped = FALSE THEN
    RETURN QUERY
    SELECT g.goal_key, g.name, g.priority, g.prompt_template,
           'User has Slack but no linked AAO account'::TEXT as reasoning
    FROM addie_goal_types g WHERE g.goal_key = 'link_account' AND g.is_active;
    RETURN;
  END IF;

  -- Priority 2: Membership pitch (warm/hot and not paying)
  IF (COALESCE(p_engagement_score, 0) >= 50 OR COALESCE(p_excitement_score, 0) >= 50)
     AND COALESCE(p_is_paying, FALSE) = FALSE THEN
    RETURN QUERY
    SELECT g.goal_key, g.name, g.priority, g.prompt_template,
           format('High engagement (%s) or excitement (%s), not paying',
                  COALESCE(p_engagement_score, 0),
                  COALESCE(p_excitement_score, 0))::TEXT as reasoning
    FROM addie_goal_types g WHERE g.goal_key = 'membership_pitch' AND g.is_active;
    RETURN;
  END IF;

  -- Priority 3: Drive value (paying but low engagement)
  IF COALESCE(p_is_paying, FALSE) = TRUE AND COALESCE(p_engagement_score, 0) < 30 THEN
    RETURN QUERY
    SELECT g.goal_key, g.name, g.priority, g.prompt_template,
           format('Paying member with low engagement (%s)', COALESCE(p_engagement_score, 0))::TEXT as reasoning
    FROM addie_goal_types g WHERE g.goal_key = 'drive_value' AND g.is_active;
    RETURN;
  END IF;

  -- Priority 4: Drive engagement (low scores, needs activation)
  IF COALESCE(p_engagement_score, 0) < 30 AND COALESCE(p_excitement_score, 0) < 30 THEN
    RETURN QUERY
    SELECT g.goal_key, g.name, g.priority, g.prompt_template,
           format('Low engagement (%s) and excitement (%s)',
                  COALESCE(p_engagement_score, 0),
                  COALESCE(p_excitement_score, 0))::TEXT as reasoning
    FROM addie_goal_types g WHERE g.goal_key = 'drive_engagement' AND g.is_active;
    RETURN;
  END IF;

  -- Priority 5: Initial contact (never talked to before)
  IF p_last_conversation_at IS NULL THEN
    RETURN QUERY
    SELECT g.goal_key, g.name, g.priority, g.prompt_template,
           'No previous conversation recorded'::TEXT as reasoning
    FROM addie_goal_types g WHERE g.goal_key = 'initial_contact' AND g.is_active;
    RETURN;
  END IF;

  -- Priority 6: Learn interests (moderate engagement, need more info)
  IF COALESCE(p_engagement_score, 0) < 50 THEN
    RETURN QUERY
    SELECT g.goal_key, g.name, g.priority, g.prompt_template,
           'Moderate engagement, need to learn more about interests'::TEXT as reasoning
    FROM addie_goal_types g WHERE g.goal_key = 'learn_interests' AND g.is_active;
    RETURN;
  END IF;

  -- Default: Deepen relationship (engaged users)
  RETURN QUERY
  SELECT g.goal_key, g.name, g.priority, g.prompt_template,
         'Engaged member, focus on deepening relationship'::TEXT as reasoning
  FROM addie_goal_types g WHERE g.goal_key = 'deepen_relationship' AND g.is_active;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION select_addie_goal IS 'Determines the best goal for Addie to pursue with a contact';

-- =====================================================
-- UNIFIED CONTACTS VIEW
-- =====================================================
-- Combines users, Slack-only contacts, and email-only contacts

CREATE OR REPLACE VIEW unified_contacts AS

-- Users with full accounts
SELECT
  'user' as contact_type,
  u.workos_user_id,
  u.email,
  COALESCE(
    NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''),
    sm.slack_real_name,
    sm.slack_display_name,
    SPLIT_PART(u.email, '@', 1)
  ) as full_name,
  u.first_name,
  u.last_name,

  -- Slack identity
  u.primary_slack_user_id as slack_user_id,
  sm.slack_display_name,
  sm.slack_real_name,
  CASE WHEN sm.mapping_status = 'mapped' THEN TRUE ELSE FALSE END as is_slack_mapped,

  -- Organization
  u.primary_organization_id as organization_id,
  o.name as organization_name,
  CASE WHEN o.subscription_status = 'active' THEN TRUE ELSE FALSE END as is_paying,

  -- Scores
  u.engagement_score,
  u.excitement_score,
  u.lifecycle_stage,
  u.slack_activity_score,
  u.email_engagement_score,
  u.conversation_score,
  u.community_score,
  u.scores_computed_at,

  -- Activity timestamps
  sm.last_slack_activity_at,
  (SELECT MAX(created_at) FROM addie_threads t
   WHERE (t.user_type = 'workos' AND t.user_id = u.workos_user_id)
      OR (t.user_type = 'slack' AND t.user_id = u.primary_slack_user_id)) as last_conversation_at,
  sm.last_outreach_at,

  -- Counts
  (SELECT COUNT(*) FROM member_insights mi
   WHERE mi.workos_user_id = u.workos_user_id AND mi.is_current = TRUE) as insight_count,
  (SELECT COUNT(*) FROM addie_threads t
   WHERE (t.user_type = 'workos' AND t.user_id = u.workos_user_id)
      OR (t.user_type = 'slack' AND t.user_id = u.primary_slack_user_id)) as conversation_count,

  u.created_at,
  u.updated_at

FROM users u
LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = u.primary_slack_user_id
LEFT JOIN organizations o ON o.workos_organization_id = u.primary_organization_id

UNION ALL

-- Slack-only contacts (no workos_user_id)
SELECT
  'slack_only' as contact_type,
  NULL as workos_user_id,
  sm.slack_email as email,
  COALESCE(sm.slack_real_name, sm.slack_display_name, sm.slack_email) as full_name,
  NULL as first_name,
  NULL as last_name,

  -- Slack identity
  sm.slack_user_id,
  sm.slack_display_name,
  sm.slack_real_name,
  FALSE as is_slack_mapped,

  -- No org info
  NULL as organization_id,
  NULL as organization_name,
  FALSE as is_paying,

  -- No scores yet (would need to compute from Slack activity)
  NULL::INTEGER as engagement_score,
  NULL::INTEGER as excitement_score,
  NULL::VARCHAR(20) as lifecycle_stage,
  NULL::INTEGER as slack_activity_score,
  NULL::INTEGER as email_engagement_score,
  NULL::INTEGER as conversation_score,
  NULL::INTEGER as community_score,
  NULL::TIMESTAMP WITH TIME ZONE as scores_computed_at,

  -- Activity
  sm.last_slack_activity_at,
  (SELECT MAX(created_at) FROM addie_threads t
   WHERE t.user_type = 'slack' AND t.user_id = sm.slack_user_id) as last_conversation_at,
  sm.last_outreach_at,

  -- Counts
  (SELECT COUNT(*) FROM member_insights mi
   WHERE mi.slack_user_id = sm.slack_user_id AND mi.is_current = TRUE) as insight_count,
  (SELECT COUNT(*) FROM addie_threads t
   WHERE t.user_type = 'slack' AND t.user_id = sm.slack_user_id) as conversation_count,

  sm.created_at,
  sm.updated_at

FROM slack_user_mappings sm
WHERE sm.workos_user_id IS NULL
  AND sm.slack_is_bot = FALSE
  AND sm.slack_is_deleted = FALSE

UNION ALL

-- Email-only contacts (no workos_user_id, no slack)
SELECT
  'email_only' as contact_type,
  NULL as workos_user_id,
  ec.email,
  COALESCE(ec.display_name, ec.email) as full_name,
  NULL as first_name,
  NULL as last_name,

  -- No Slack
  NULL as slack_user_id,
  NULL as slack_display_name,
  NULL as slack_real_name,
  FALSE as is_slack_mapped,

  -- Org from email domain matching
  ec.organization_id,
  o.name as organization_name,
  FALSE as is_paying,

  -- No scores
  NULL::INTEGER as engagement_score,
  NULL::INTEGER as excitement_score,
  NULL::VARCHAR(20) as lifecycle_stage,
  NULL::INTEGER as slack_activity_score,
  NULL::INTEGER as email_engagement_score,
  NULL::INTEGER as conversation_score,
  NULL::INTEGER as community_score,
  NULL::TIMESTAMP WITH TIME ZONE as scores_computed_at,

  -- Activity
  NULL::TIMESTAMP WITH TIME ZONE as last_slack_activity_at,
  NULL::TIMESTAMP WITH TIME ZONE as last_conversation_at,
  NULL::TIMESTAMP WITH TIME ZONE as last_outreach_at,

  -- Counts
  0 as insight_count,
  0 as conversation_count,

  ec.created_at,
  ec.updated_at

FROM email_contacts ec
LEFT JOIN organizations o ON o.workos_organization_id = ec.organization_id
WHERE ec.workos_user_id IS NULL
  -- Exclude if they also exist as Slack-only
  AND NOT EXISTS (
    SELECT 1 FROM slack_user_mappings sm
    WHERE sm.slack_email = ec.email AND sm.workos_user_id IS NULL
  );

COMMENT ON VIEW unified_contacts IS 'All contacts (users, Slack-only, email-only) with scores and activity';

-- =====================================================
-- UNIFIED CONTACTS WITH GOALS
-- =====================================================
-- Adds the recommended goal for each contact

CREATE OR REPLACE VIEW unified_contacts_with_goals AS
SELECT
  uc.*,
  g.goal_key,
  g.goal_name,
  g.priority as goal_priority,
  g.prompt_template as goal_prompt,
  g.reasoning as goal_reasoning
FROM unified_contacts uc
CROSS JOIN LATERAL select_addie_goal(
  uc.workos_user_id IS NOT NULL,  -- has_workos_account
  uc.is_slack_mapped,
  uc.engagement_score,
  uc.excitement_score,
  uc.is_paying,
  uc.last_conversation_at
) g;

COMMENT ON VIEW unified_contacts_with_goals IS 'All contacts with their recommended Addie goal';

-- =====================================================
-- SLACK ACTIVITY SUMMARY FOR UNMAPPED USERS
-- =====================================================
-- Provides engagement-like metrics for Slack-only contacts

CREATE OR REPLACE VIEW slack_contact_activity AS
SELECT
  sm.slack_user_id,
  sm.slack_email,
  sm.slack_display_name,
  sm.slack_real_name,
  sm.mapping_status,

  -- Activity summary (last 30 days)
  COALESCE((
    SELECT SUM(message_count)
    FROM slack_activity_daily sad
    WHERE sad.slack_user_id = sm.slack_user_id
      AND sad.activity_date >= CURRENT_DATE - INTERVAL '30 days'
  ), 0) as messages_30d,

  COALESCE((
    SELECT SUM(reaction_count)
    FROM slack_activity_daily sad
    WHERE sad.slack_user_id = sm.slack_user_id
      AND sad.activity_date >= CURRENT_DATE - INTERVAL '30 days'
  ), 0) as reactions_30d,

  COALESCE((
    SELECT SUM(thread_reply_count)
    FROM slack_activity_daily sad
    WHERE sad.slack_user_id = sm.slack_user_id
      AND sad.activity_date >= CURRENT_DATE - INTERVAL '30 days'
  ), 0) as thread_replies_30d,

  -- Conversation with Addie
  (SELECT COUNT(*) FROM addie_threads t
   WHERE t.user_type = 'slack' AND t.user_id = sm.slack_user_id) as addie_conversations,

  (SELECT MAX(created_at) FROM addie_threads t
   WHERE t.user_type = 'slack' AND t.user_id = sm.slack_user_id) as last_addie_conversation,

  -- Insights we've gathered
  (SELECT COUNT(*) FROM member_insights mi
   WHERE mi.slack_user_id = sm.slack_user_id AND mi.is_current = TRUE) as insight_count,

  -- Estimated engagement score (same formula as for users)
  LEAST(100,
    LEAST(30, COALESCE((
      SELECT (SUM(message_count) / 2 + SUM(reaction_count) / 5 + SUM(thread_reply_count))
      FROM slack_activity_daily sad
      WHERE sad.slack_user_id = sm.slack_user_id
        AND sad.activity_date >= CURRENT_DATE - INTERVAL '30 days'
    ), 0)) +
    LEAST(25, (SELECT COUNT(*) * 3 FROM addie_threads t WHERE t.user_type = 'slack' AND t.user_id = sm.slack_user_id))
  )::INTEGER as estimated_engagement_score,

  sm.last_slack_activity_at,
  sm.last_outreach_at,
  sm.outreach_opt_out,
  sm.created_at

FROM slack_user_mappings sm
WHERE sm.slack_is_bot = FALSE
  AND sm.slack_is_deleted = FALSE;

COMMENT ON VIEW slack_contact_activity IS 'Activity summary for Slack contacts, including unmapped users';

-- =====================================================
-- EMAIL CONTACT ACTIVITY SUMMARY
-- =====================================================

CREATE OR REPLACE VIEW email_contact_activity AS
SELECT
  ec.id as email_contact_id,
  ec.email,
  ec.display_name,
  ec.domain,
  ec.mapping_status,
  ec.organization_id,
  o.name as organization_name,

  -- Email activity
  ec.email_count,
  ec.first_seen_at,
  ec.last_seen_at,

  -- Inbound vs outbound
  (SELECT COUNT(*) FROM email_contact_activities eca
   JOIN email_activity_contacts eac ON eac.activity_id = eca.id
   WHERE eac.contact_id = ec.id AND eca.direction = 'inbound') as inbound_count,

  (SELECT COUNT(*) FROM email_contact_activities eca
   JOIN email_activity_contacts eac ON eac.activity_id = eca.id
   WHERE eac.contact_id = ec.id AND eca.direction = 'outbound') as outbound_count,

  -- Recent activity
  (SELECT MAX(eca.email_date) FROM email_contact_activities eca
   JOIN email_activity_contacts eac ON eac.activity_id = eca.id
   WHERE eac.contact_id = ec.id) as last_email_at,

  -- Insights extracted from emails
  (SELECT COUNT(*) FROM email_contact_activities eca
   JOIN email_activity_contacts eac ON eac.activity_id = eca.id
   WHERE eac.contact_id = ec.id AND eca.insights IS NOT NULL) as emails_with_insights,

  ec.created_at,
  ec.updated_at

FROM email_contacts ec
LEFT JOIN organizations o ON o.workos_organization_id = ec.organization_id;

COMMENT ON VIEW email_contact_activity IS 'Activity summary for email contacts';
