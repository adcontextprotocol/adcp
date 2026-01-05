-- Fix compute_user_engagement_score community score query
-- The org_activities table uses 'organization_id', not 'workos_organization_id'

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
  -- org_activities uses 'organization_id' column (not workos_organization_id)
  SELECT LEAST(25, COALESCE(
    (
      SELECT
        -- Logged activities: up to 15 points
        LEAST(15, COUNT(*) * 3)
      FROM org_activities oa
      JOIN organization_memberships om ON om.workos_organization_id = oa.organization_id
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
