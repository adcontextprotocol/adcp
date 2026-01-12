-- Migration: 149_simplify_engagement_scoring.sql
-- Simplify engagement scoring to focus on actual observable activity
--
-- Previous scoring was too complex and had thresholds appropriate for
-- a full-time job, not a nonprofit side-commitment.
--
-- New scoring (0-100, capped):
-- - Slack activity: 10 points per action (message, reaction, thread reply) in last 30 days
-- - Events: 20 points per event registered or attended
--
-- Removed:
-- - Email engagement (unreliable tracking, not a good signal)
-- - Conversation score (that's on us to initiate, not them)
-- - Community score based on org_activities (replaced by events)

-- =====================================================
-- SIMPLIFIED USER ENGAGEMENT SCORE
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
  v_event_score INTEGER := 0;
  v_total_score INTEGER := 0;
BEGIN
  -- Get the user's primary Slack ID
  SELECT u.primary_slack_user_id INTO v_slack_user_id
  FROM users u
  WHERE u.workos_user_id = p_workos_user_id;

  -- =========================================
  -- SLACK ACTIVITY SCORE (10 points per action)
  -- =========================================
  -- Messages, reactions, and thread replies all count equally
  IF v_slack_user_id IS NOT NULL THEN
    SELECT COALESCE(
      (
        SELECT
          (COALESCE(SUM(message_count), 0) +
           COALESCE(SUM(reaction_count), 0) +
           COALESCE(SUM(thread_reply_count), 0)) * 10
        FROM slack_activity_daily
        WHERE slack_user_id = v_slack_user_id
          AND activity_date >= CURRENT_DATE - INTERVAL '30 days'
      ), 0
    ) INTO v_slack_score;
  END IF;

  -- =========================================
  -- EVENT SCORE (20 points per event)
  -- =========================================
  -- Count events registered for or attended
  SELECT COALESCE(
    (
      SELECT COUNT(*) * 20
      FROM event_registrations er
      WHERE er.workos_user_id = p_workos_user_id
        AND (
          er.created_at >= NOW() - INTERVAL '30 days'
          OR er.checked_in_at >= NOW() - INTERVAL '30 days'
        )
    ), 0
  ) INTO v_event_score;

  -- Calculate total (max 100)
  v_total_score := LEAST(100, v_slack_score + v_event_score);

  -- Return with backward-compatible columns
  -- slack_activity_score = slack score
  -- community_score = event score
  -- email_engagement_score and conversation_score = 0 (deprecated)
  RETURN QUERY SELECT
    v_total_score,
    LEAST(100, v_slack_score),
    0,  -- email_engagement_score (deprecated)
    0,  -- conversation_score (deprecated)
    LEAST(100, v_event_score);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION compute_user_engagement_score IS 'Simplified engagement score (0-100): 10 pts per Slack action + 20 pts per event, based on last 30 days activity';

-- =====================================================
-- UPDATE SLACK-ONLY USER ENGAGEMENT SCORE
-- =====================================================
-- For users who only have Slack (no WorkOS account)

CREATE OR REPLACE FUNCTION compute_slack_user_engagement_score(p_slack_user_id VARCHAR(255))
RETURNS TABLE (
  engagement_score INTEGER,
  slack_activity_score INTEGER,
  email_engagement_score INTEGER,
  conversation_score INTEGER,
  community_score INTEGER
) AS $$
DECLARE
  v_slack_score INTEGER := 0;
  v_total_score INTEGER := 0;
BEGIN
  -- =========================================
  -- SLACK ACTIVITY SCORE (10 points per action)
  -- =========================================
  SELECT COALESCE(
    (
      SELECT
        (COALESCE(SUM(message_count), 0) +
         COALESCE(SUM(reaction_count), 0) +
         COALESCE(SUM(thread_reply_count), 0)) * 10
      FROM slack_activity_daily
      WHERE slack_user_id = p_slack_user_id
        AND activity_date >= CURRENT_DATE - INTERVAL '30 days'
    ), 0
  ) INTO v_slack_score;

  -- For Slack-only users, we only have Slack activity
  v_total_score := LEAST(100, v_slack_score);

  RETURN QUERY SELECT
    v_total_score,
    LEAST(100, v_slack_score),
    0,  -- email_engagement_score (not applicable)
    0,  -- conversation_score (deprecated)
    0;  -- community_score (no event data for slack-only)
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION compute_slack_user_engagement_score IS 'Engagement score for Slack-only users: 10 pts per Slack action (capped at 100)';
