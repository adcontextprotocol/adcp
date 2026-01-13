-- Migration: Fix outreach_goal_stats view to use planner tables
--
-- The original view joined insight_goals with member_outreach via insight_goal_id,
-- but the planner-based outreach (the default) uses outreach_goals and user_goal_history.
-- The planner never sets insight_goal_id, so stats always show 0s.
--
-- This migration updates the view to join through user_goal_history.outreach_id
-- to get the actual outreach data linked to planner goals.

-- =====================================================
-- VIEW: Response rates aggregated by outreach goal
-- =====================================================

-- Drop the old view first (column types are changing)
DROP VIEW IF EXISTS outreach_goal_stats;

CREATE VIEW outreach_goal_stats AS
SELECT
  og.id as goal_id,
  og.name as goal_name,
  og.description as goal_question,
  og.category as goal_type,
  og.is_enabled,
  COUNT(ugh.id) as total_sent,
  COUNT(ugh.id) FILTER (WHERE ugh.status IN ('responded', 'success', 'declined')) as total_responded,
  COUNT(ugh.id) FILTER (WHERE ugh.status = 'success') as total_insights,
  ROUND(
    100.0 * COUNT(ugh.id) FILTER (WHERE ugh.status IN ('responded', 'success', 'declined')) / NULLIF(COUNT(ugh.id), 0),
    1
  ) as response_rate_pct,
  ROUND(
    100.0 * COUNT(ugh.id) FILTER (WHERE ugh.status = 'success') / NULLIF(COUNT(ugh.id) FILTER (WHERE ugh.status IN ('responded', 'success', 'declined')), 0),
    1
  ) as insight_conversion_rate_pct,
  -- Sentiment breakdown for responses (from member_outreach via outreach_id)
  COUNT(mo.id) FILTER (WHERE mo.response_sentiment = 'positive') as positive_responses,
  COUNT(mo.id) FILTER (WHERE mo.response_sentiment = 'neutral') as neutral_responses,
  COUNT(mo.id) FILTER (WHERE mo.response_sentiment = 'negative') as negative_responses,
  COUNT(mo.id) FILTER (WHERE mo.response_sentiment = 'refusal') as refusal_responses,
  -- Intent breakdown (from user_goal_history or member_outreach)
  COUNT(COALESCE(ugh.response_intent, mo.response_intent)) FILTER (WHERE COALESCE(ugh.response_intent, mo.response_intent) = 'converted') as converted_count,
  COUNT(COALESCE(ugh.response_intent, mo.response_intent)) FILTER (WHERE COALESCE(ugh.response_intent, mo.response_intent) = 'interested') as interested_count,
  COUNT(COALESCE(ugh.response_intent, mo.response_intent)) FILTER (WHERE COALESCE(ugh.response_intent, mo.response_intent) = 'deferred') as deferred_count,
  COUNT(COALESCE(ugh.response_intent, mo.response_intent)) FILTER (WHERE COALESCE(ugh.response_intent, mo.response_intent) = 'question') as question_count,
  COUNT(COALESCE(ugh.response_intent, mo.response_intent)) FILTER (WHERE COALESCE(ugh.response_intent, mo.response_intent) = 'objection') as objection_count,
  -- Time metrics
  MIN(ugh.created_at) as first_outreach_at,
  MAX(ugh.last_attempt_at) as last_outreach_at
FROM outreach_goals og
LEFT JOIN user_goal_history ugh ON ugh.goal_id = og.id
LEFT JOIN member_outreach mo ON mo.id = ugh.outreach_id
GROUP BY og.id, og.name, og.description, og.category, og.is_enabled
ORDER BY COUNT(ugh.id) DESC;

COMMENT ON VIEW outreach_goal_stats IS 'Response rates and sentiment breakdown per outreach goal (planner-based)';
