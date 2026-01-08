-- Migration: Outreach response rates by goal type
-- Adds a view and function for analyzing outreach performance by goal

-- =====================================================
-- VIEW: Response rates aggregated by insight goal
-- =====================================================

CREATE OR REPLACE VIEW outreach_goal_stats AS
SELECT
  ig.id as goal_id,
  ig.name as goal_name,
  ig.question as goal_question,
  ig.goal_type,
  ig.is_enabled,
  COUNT(mo.id) as total_sent,
  COUNT(mo.id) FILTER (WHERE mo.user_responded) as total_responded,
  COUNT(mo.id) FILTER (WHERE mo.insight_extracted) as total_insights,
  ROUND(
    100.0 * COUNT(mo.id) FILTER (WHERE mo.user_responded) / NULLIF(COUNT(mo.id), 0),
    1
  ) as response_rate_pct,
  ROUND(
    100.0 * COUNT(mo.id) FILTER (WHERE mo.insight_extracted) / NULLIF(COUNT(mo.id) FILTER (WHERE mo.user_responded), 0),
    1
  ) as insight_conversion_rate_pct,
  -- Sentiment breakdown for responses
  COUNT(mo.id) FILTER (WHERE mo.response_sentiment = 'positive') as positive_responses,
  COUNT(mo.id) FILTER (WHERE mo.response_sentiment = 'neutral') as neutral_responses,
  COUNT(mo.id) FILTER (WHERE mo.response_sentiment = 'negative') as negative_responses,
  COUNT(mo.id) FILTER (WHERE mo.response_sentiment = 'refusal') as refusal_responses,
  -- Intent breakdown
  COUNT(mo.id) FILTER (WHERE mo.response_intent = 'converted') as converted_count,
  COUNT(mo.id) FILTER (WHERE mo.response_intent = 'interested') as interested_count,
  COUNT(mo.id) FILTER (WHERE mo.response_intent = 'deferred') as deferred_count,
  COUNT(mo.id) FILTER (WHERE mo.response_intent = 'question') as question_count,
  COUNT(mo.id) FILTER (WHERE mo.response_intent = 'objection') as objection_count,
  -- Time metrics
  MIN(mo.sent_at) as first_outreach_at,
  MAX(mo.sent_at) as last_outreach_at
FROM insight_goals ig
LEFT JOIN member_outreach mo ON mo.insight_goal_id = ig.id
GROUP BY ig.id, ig.name, ig.question, ig.goal_type, ig.is_enabled
ORDER BY total_sent DESC;

-- =====================================================
-- VIEW: Overall outreach stats with time windows
-- =====================================================

CREATE OR REPLACE VIEW outreach_time_stats AS
SELECT
  -- Today
  COUNT(*) FILTER (WHERE sent_at >= CURRENT_DATE) as sent_today,
  COUNT(*) FILTER (WHERE sent_at >= CURRENT_DATE AND user_responded) as responded_today,
  -- This week
  COUNT(*) FILTER (WHERE sent_at >= CURRENT_DATE - INTERVAL '7 days') as sent_this_week,
  COUNT(*) FILTER (WHERE sent_at >= CURRENT_DATE - INTERVAL '7 days' AND user_responded) as responded_this_week,
  -- This month
  COUNT(*) FILTER (WHERE sent_at >= CURRENT_DATE - INTERVAL '30 days') as sent_this_month,
  COUNT(*) FILTER (WHERE sent_at >= CURRENT_DATE - INTERVAL '30 days' AND user_responded) as responded_this_month,
  -- All time
  COUNT(*) as total_sent,
  COUNT(*) FILTER (WHERE user_responded) as total_responded,
  COUNT(*) FILTER (WHERE insight_extracted) as total_insights,
  -- Response rate
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE user_responded) / NULLIF(COUNT(*), 0),
    1
  ) as overall_response_rate_pct
FROM member_outreach;

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON VIEW outreach_goal_stats IS 'Response rates and sentiment breakdown per insight goal';
COMMENT ON VIEW outreach_time_stats IS 'Outreach statistics with time-windowed breakdowns';
