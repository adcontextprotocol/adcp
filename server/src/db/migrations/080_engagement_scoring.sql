-- Migration: 075_engagement_scoring.sql
-- Functions to compute engagement and excitement scores
--
-- Engagement Score (0-100): Based on observable activity
-- - Slack activity (messages, reactions, threads)
-- - Email engagement (opens, clicks)
-- - Addie conversations
-- - Community participation (working groups, events)
--
-- Excitement Score (0-100): Based on expressed sentiment
-- - Conversation insights indicating enthusiasm
-- - Stated intentions (building, evaluating, planning)
-- - Referrals made
--
-- Lifecycle Stage: Derived from scores and activity patterns
-- - new: Just created, minimal activity
-- - active: Regular engagement
-- - engaged: High engagement, participating
-- - champion: Very high engagement + excitement
-- - at_risk: Was engaged, now dropping off

-- =====================================================
-- COMPUTE USER ENGAGEMENT SCORE
-- =====================================================

CREATE OR REPLACE FUNCTION compute_user_engagement_score(p_workos_user_id VARCHAR(255))
RETURNS TABLE (
  engagement_score INTEGER,
  slack_activity_score INTEGER,
  email_engagement_score INTEGER,
  conversation_score INTEGER,
  community_score INTEGER
) AS $$
DECLARE
  v_slack_user_id VARCHAR(255);
  v_slack_score INTEGER := 0;
  v_email_score INTEGER := 0;
  v_conversation_score INTEGER := 0;
  v_community_score INTEGER := 0;
  v_total_score INTEGER := 0;
BEGIN
  -- Get the user's primary Slack ID
  SELECT u.primary_slack_user_id INTO v_slack_user_id
  FROM users u
  WHERE u.workos_user_id = p_workos_user_id;

  -- =========================================
  -- SLACK ACTIVITY SCORE (0-30 points)
  -- =========================================
  -- Based on last 30 days of activity
  IF v_slack_user_id IS NOT NULL THEN
    SELECT LEAST(30, COALESCE(
      (
        SELECT
          -- Messages: up to 15 points (1 point per 2 messages, max 30 messages)
          LEAST(15, COALESCE(SUM(message_count), 0) / 2) +
          -- Reactions: up to 5 points (1 point per 5 reactions)
          LEAST(5, COALESCE(SUM(reaction_count), 0) / 5) +
          -- Thread replies: up to 10 points (1 point per reply)
          LEAST(10, COALESCE(SUM(thread_reply_count), 0))
        FROM slack_activity_daily
        WHERE slack_user_id = v_slack_user_id
          AND activity_date >= CURRENT_DATE - INTERVAL '30 days'
      ), 0
    )) INTO v_slack_score;
  END IF;

  -- =========================================
  -- EMAIL ENGAGEMENT SCORE (0-20 points)
  -- =========================================
  -- Based on email opens and clicks in last 30 days
  SELECT LEAST(20, COALESCE(
    (
      SELECT
        -- Opens: up to 10 points (2 points per unique email opened)
        LEAST(10, COUNT(DISTINCT CASE WHEN opened_at IS NOT NULL THEN tracking_id END) * 2) +
        -- Clicks: up to 10 points (5 points per click)
        LEAST(10, COUNT(DISTINCT CASE WHEN first_clicked_at IS NOT NULL THEN tracking_id END) * 5)
      FROM email_events
      WHERE workos_user_id = p_workos_user_id
        AND sent_at >= NOW() - INTERVAL '30 days'
    ), 0
  )) INTO v_email_score;

  -- =========================================
  -- CONVERSATION SCORE (0-25 points)
  -- =========================================
  -- Based on Addie conversations and insights extracted
  SELECT LEAST(25, COALESCE(
    (
      SELECT
        -- Conversations: up to 15 points (3 points per conversation)
        LEAST(15, COUNT(DISTINCT t.thread_id) * 3) +
        -- Insights extracted: up to 10 points (2 points per insight)
        LEAST(10, (
          SELECT COUNT(*) * 2
          FROM member_insights mi
          WHERE mi.workos_user_id = p_workos_user_id
            AND mi.is_current = TRUE
            AND mi.created_at >= NOW() - INTERVAL '30 days'
        ))
      FROM addie_threads t
      WHERE ((t.user_type = 'workos' AND t.user_id = p_workos_user_id)
             OR (v_slack_user_id IS NOT NULL AND t.user_type = 'slack' AND t.user_id = v_slack_user_id))
        AND t.created_at >= NOW() - INTERVAL '30 days'
    ), 0
  )) INTO v_conversation_score;

  -- =========================================
  -- COMMUNITY SCORE (0-25 points)
  -- =========================================
  -- Based on working groups, events, and other participation
  -- For now, this is a placeholder - we'll expand as we add more community features
  -- Currently checks for org activity participation
  SELECT LEAST(25, COALESCE(
    (
      SELECT
        -- Logged activities: up to 15 points
        LEAST(15, COUNT(*) * 3)
      FROM org_activities oa
      JOIN organization_memberships om ON om.workos_organization_id = oa.workos_organization_id
      WHERE om.workos_user_id = p_workos_user_id
        AND oa.activity_date >= CURRENT_DATE - INTERVAL '30 days'
        AND oa.activity_type IN ('event', 'meeting', 'call')
    ), 0
  )) INTO v_community_score;

  -- Calculate total (max 100)
  v_total_score := LEAST(100, v_slack_score + v_email_score + v_conversation_score + v_community_score);

  RETURN QUERY SELECT
    v_total_score,
    v_slack_score,
    v_email_score,
    v_conversation_score,
    v_community_score;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION compute_user_engagement_score IS 'Computes engagement score (0-100) from activity data for a user';

-- =====================================================
-- COMPUTE USER EXCITEMENT SCORE
-- =====================================================
-- This is a simpler scoring based on insights we've captured

CREATE OR REPLACE FUNCTION compute_user_excitement_score(p_workos_user_id VARCHAR(255))
RETURNS INTEGER AS $$
DECLARE
  v_score INTEGER := 0;
  v_slack_user_id VARCHAR(255);
  v_insight_count INTEGER;
  v_positive_insights INTEGER;
BEGIN
  -- Get Slack user ID
  SELECT primary_slack_user_id INTO v_slack_user_id
  FROM users WHERE workos_user_id = p_workos_user_id;

  -- Count total current insights
  SELECT COUNT(*) INTO v_insight_count
  FROM member_insights mi
  WHERE (mi.workos_user_id = p_workos_user_id
         OR (v_slack_user_id IS NOT NULL AND mi.slack_user_id = v_slack_user_id))
    AND mi.is_current = TRUE;

  -- Count "positive" insights (building, interest, goals)
  -- These insight types indicate excitement about agentic advertising
  SELECT COUNT(*) INTO v_positive_insights
  FROM member_insights mi
  JOIN member_insight_types mit ON mit.id = mi.insight_type_id
  WHERE (mi.workos_user_id = p_workos_user_id
         OR (v_slack_user_id IS NOT NULL AND mi.slack_user_id = v_slack_user_id))
    AND mi.is_current = TRUE
    AND mit.name IN ('building', 'interest', 'aao_goals', 'company_focus');

  -- Base score from having insights at all (shows engagement with Addie)
  -- Up to 30 points for having insights
  v_score := LEAST(30, v_insight_count * 10);

  -- Bonus for positive/excited insights
  -- Up to 50 additional points
  v_score := v_score + LEAST(50, v_positive_insights * 15);

  -- Check for high-confidence insights (indicates strong signal)
  -- Up to 20 additional points
  v_score := v_score + LEAST(20, (
    SELECT COUNT(*) * 10
    FROM member_insights mi
    WHERE (mi.workos_user_id = p_workos_user_id
           OR (v_slack_user_id IS NOT NULL AND mi.slack_user_id = v_slack_user_id))
      AND mi.is_current = TRUE
      AND mi.confidence = 'high'
  ));

  RETURN LEAST(100, v_score);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION compute_user_excitement_score IS 'Computes excitement score (0-100) from conversation insights';

-- =====================================================
-- DETERMINE LIFECYCLE STAGE
-- =====================================================

CREATE OR REPLACE FUNCTION determine_lifecycle_stage(
  p_engagement_score INTEGER,
  p_excitement_score INTEGER,
  p_previous_engagement INTEGER DEFAULT NULL
) RETURNS VARCHAR(20) AS $$
BEGIN
  -- Champion: Very high in both dimensions
  IF p_engagement_score >= 70 AND p_excitement_score >= 70 THEN
    RETURN 'champion';
  END IF;

  -- Engaged: High engagement or excitement
  IF p_engagement_score >= 50 OR p_excitement_score >= 50 THEN
    RETURN 'engaged';
  END IF;

  -- At risk: Had engagement before, now dropping
  IF p_previous_engagement IS NOT NULL AND p_previous_engagement >= 40 AND p_engagement_score < 20 THEN
    RETURN 'at_risk';
  END IF;

  -- Active: Some engagement
  IF p_engagement_score >= 20 THEN
    RETURN 'active';
  END IF;

  -- New: Minimal activity
  RETURN 'new';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION determine_lifecycle_stage IS 'Determines user lifecycle stage from scores';

-- =====================================================
-- UPDATE ALL USER SCORES
-- =====================================================

CREATE OR REPLACE FUNCTION update_user_scores(p_workos_user_id VARCHAR(255))
RETURNS VOID AS $$
DECLARE
  v_scores RECORD;
  v_excitement INTEGER;
  v_previous_engagement INTEGER;
  v_lifecycle VARCHAR(20);
BEGIN
  -- Get previous engagement for at_risk detection
  SELECT engagement_score INTO v_previous_engagement
  FROM users WHERE workos_user_id = p_workos_user_id;

  -- Compute engagement scores
  SELECT * INTO v_scores FROM compute_user_engagement_score(p_workos_user_id);

  -- Compute excitement score
  v_excitement := compute_user_excitement_score(p_workos_user_id);

  -- Determine lifecycle stage
  v_lifecycle := determine_lifecycle_stage(
    v_scores.engagement_score,
    v_excitement,
    v_previous_engagement
  );

  -- Update user record
  UPDATE users SET
    engagement_score = v_scores.engagement_score,
    excitement_score = v_excitement,
    slack_activity_score = v_scores.slack_activity_score,
    email_engagement_score = v_scores.email_engagement_score,
    conversation_score = v_scores.conversation_score,
    community_score = v_scores.community_score,
    lifecycle_stage = v_lifecycle,
    scores_computed_at = NOW(),
    updated_at = NOW()
  WHERE workos_user_id = p_workos_user_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_user_scores IS 'Recomputes all scores for a user and updates their record';

-- =====================================================
-- BATCH UPDATE ALL STALE SCORES
-- =====================================================

CREATE OR REPLACE FUNCTION update_stale_user_scores(p_max_users INTEGER DEFAULT 100)
RETURNS INTEGER AS $$
DECLARE
  v_user RECORD;
  v_count INTEGER := 0;
BEGIN
  -- Find users with stale or missing scores
  FOR v_user IN
    SELECT workos_user_id
    FROM users
    WHERE scores_computed_at IS NULL
       OR scores_computed_at < NOW() - INTERVAL '1 day'
    ORDER BY scores_computed_at NULLS FIRST
    LIMIT p_max_users
  LOOP
    PERFORM update_user_scores(v_user.workos_user_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_stale_user_scores IS 'Batch updates scores for users with stale data';

-- =====================================================
-- UPDATE ORGANIZATION SCORES
-- =====================================================

CREATE OR REPLACE FUNCTION update_organization_scores(p_workos_organization_id VARCHAR(255))
RETURNS VOID AS $$
DECLARE
  v_engagement INTEGER;
  v_excitement INTEGER;
  v_champion_id VARCHAR(255);
  v_lifecycle VARCHAR(20);
  v_is_paying BOOLEAN;
BEGIN
  -- Check if org is paying
  SELECT subscription_status = 'active' INTO v_is_paying
  FROM organizations WHERE workos_organization_id = p_workos_organization_id;

  -- Compute org engagement (average of member engagement + org activities)
  SELECT
    LEAST(100, COALESCE(AVG(u.engagement_score), 0) + (
      SELECT LEAST(30, COUNT(*) * 5)
      FROM org_activities oa
      WHERE oa.workos_organization_id = p_workos_organization_id
        AND oa.activity_date >= CURRENT_DATE - INTERVAL '30 days'
    ))
  INTO v_engagement
  FROM users u
  JOIN organization_memberships om ON om.workos_user_id = u.workos_user_id
  WHERE om.workos_organization_id = p_workos_organization_id;

  -- Org excitement is max of member excitement
  SELECT MAX(u.excitement_score)
  INTO v_excitement
  FROM users u
  JOIN organization_memberships om ON om.workos_user_id = u.workos_user_id
  WHERE om.workos_organization_id = p_workos_organization_id;

  -- Find champion (highest combined score)
  SELECT u.workos_user_id
  INTO v_champion_id
  FROM users u
  JOIN organization_memberships om ON om.workos_user_id = u.workos_user_id
  WHERE om.workos_organization_id = p_workos_organization_id
  ORDER BY (u.engagement_score + u.excitement_score) DESC
  LIMIT 1;

  -- Determine org lifecycle
  IF v_is_paying THEN
    IF COALESCE(v_engagement, 0) < 30 THEN
      v_lifecycle := 'at_risk';
    ELSE
      v_lifecycle := 'paying';
    END IF;
  ELSIF COALESCE(v_engagement, 0) >= 50 OR COALESCE(v_excitement, 0) >= 50 THEN
    v_lifecycle := 'evaluating';
  ELSE
    v_lifecycle := 'prospect';
  END IF;

  -- Update organization
  UPDATE organizations SET
    engagement_score = COALESCE(v_engagement, 0),
    excitement_score = COALESCE(v_excitement, 0),
    champion_workos_user_id = v_champion_id,
    org_lifecycle_stage = v_lifecycle,
    org_scores_computed_at = NOW(),
    updated_at = NOW()
  WHERE workos_organization_id = p_workos_organization_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_organization_scores IS 'Aggregates member scores to organization level';

-- =====================================================
-- BATCH UPDATE ALL ORGANIZATION SCORES
-- =====================================================

CREATE OR REPLACE FUNCTION update_all_organization_scores()
RETURNS INTEGER AS $$
DECLARE
  v_org RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_org IN
    SELECT workos_organization_id FROM organizations
  LOOP
    PERFORM update_organization_scores(v_org.workos_organization_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_all_organization_scores IS 'Updates scores for all organizations';

-- =====================================================
-- HELPER VIEW: Users needing outreach
-- =====================================================

CREATE OR REPLACE VIEW users_needing_outreach AS
SELECT
  u.workos_user_id,
  u.email,
  u.first_name,
  u.last_name,
  u.engagement_score,
  u.excitement_score,
  u.lifecycle_stage,
  u.primary_slack_user_id,
  sm.mapping_status as slack_mapping_status,
  sm.last_outreach_at,
  sm.outreach_opt_out,
  o.name as organization_name,
  o.subscription_status,

  -- Determine recommended action
  CASE
    -- Not linked to Slack yet
    WHEN u.primary_slack_user_id IS NULL THEN 'link_slack'
    -- Slack not mapped to AAO account
    WHEN sm.mapping_status != 'mapped' THEN 'link_account'
    -- Low engagement, needs activation
    WHEN u.engagement_score < 30 AND u.excitement_score < 30 THEN 'drive_engagement'
    -- Ready for membership pitch (not already paying)
    WHEN (u.engagement_score >= 50 OR u.excitement_score >= 50)
         AND (o.subscription_status IS NULL OR o.subscription_status != 'active')
    THEN 'membership_pitch'
    -- Paying but low engagement
    WHEN o.subscription_status = 'active' AND u.engagement_score < 30 THEN 'drive_value'
    -- Engaged, deepen relationship
    ELSE 'deepen_relationship'
  END as recommended_action

FROM users u
LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = u.primary_slack_user_id
LEFT JOIN organizations o ON o.workos_organization_id = u.primary_organization_id
WHERE sm.outreach_opt_out IS NOT TRUE
  AND sm.slack_is_bot IS NOT TRUE
ORDER BY
  -- Prioritize by recommended action and scores
  CASE
    WHEN sm.mapping_status != 'mapped' THEN 1
    WHEN u.engagement_score >= 50 OR u.excitement_score >= 50 THEN 2
    WHEN u.engagement_score < 30 THEN 3
    ELSE 4
  END,
  (u.engagement_score + u.excitement_score) DESC;

COMMENT ON VIEW users_needing_outreach IS 'Users ranked by outreach priority with recommended action';
