-- Migration: 148_slack_only_engagement_scores.sql
-- Compute engagement scores for Slack-only contacts based on their activity data
-- Previously these showed as NULL/empty in the admin dashboard

-- Drop dependent view first
DROP VIEW IF EXISTS unified_contacts_with_goals;

-- Recreate unified_contacts with computed scores for Slack-only users
CREATE OR REPLACE VIEW unified_contacts AS

-- Users with full accounts (unchanged)
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

-- Slack-only contacts with computed engagement scores
-- Uses LATERAL joins to compute scores once per row for better performance
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

  -- Organization (none for Slack-only)
  NULL as organization_id,
  NULL as organization_name,
  FALSE as is_paying,

  -- Computed scores using LATERAL joins (each computed once)
  LEAST(100, COALESCE(slack_scores.score, 0) + COALESCE(conv_scores.score, 0))::INTEGER as engagement_score,
  NULL::INTEGER as excitement_score,
  NULL::VARCHAR(20) as lifecycle_stage,
  slack_scores.score as slack_activity_score,
  NULL::INTEGER as email_engagement_score,
  conv_scores.score as conversation_score,
  NULL::INTEGER as community_score,
  NULL::TIMESTAMP WITH TIME ZONE as scores_computed_at,

  -- Activity
  sm.last_slack_activity_at,
  conv_stats.last_conversation_at,
  sm.last_outreach_at,

  -- Counts
  insight_stats.insight_count,
  conv_stats.conversation_count,

  sm.created_at,
  sm.updated_at

FROM slack_user_mappings sm
-- Slack activity score (0-30 points) from last 30 days
CROSS JOIN LATERAL (
  SELECT LEAST(30,
    LEAST(15, COALESCE(SUM(message_count), 0) / 2) +
    LEAST(5, COALESCE(SUM(reaction_count), 0) / 5) +
    LEAST(10, COALESCE(SUM(thread_reply_count), 0))
  )::INTEGER as score
  FROM slack_activity_daily sad
  WHERE sad.slack_user_id = sm.slack_user_id
    AND sad.activity_date >= CURRENT_DATE - INTERVAL '30 days'
) slack_scores
-- Conversation score (0-25 points) from last 30 days
CROSS JOIN LATERAL (
  SELECT LEAST(25,
    LEAST(15, COALESCE(thread_count, 0) * 3) +
    LEAST(10, COALESCE(insight_count, 0) * 2)
  )::INTEGER as score
  FROM (
    SELECT
      (SELECT COUNT(DISTINCT thread_id) FROM addie_threads t
       WHERE t.user_type = 'slack' AND t.user_id = sm.slack_user_id
         AND t.created_at >= NOW() - INTERVAL '30 days') as thread_count,
      (SELECT COUNT(*) FROM member_insights mi
       WHERE mi.slack_user_id = sm.slack_user_id
         AND mi.is_current = TRUE
         AND mi.created_at >= NOW() - INTERVAL '30 days') as insight_count
  ) counts
) conv_scores
-- Conversation stats (count and last activity)
CROSS JOIN LATERAL (
  SELECT
    COUNT(*) as conversation_count,
    MAX(created_at) as last_conversation_at
  FROM addie_threads t
  WHERE t.user_type = 'slack' AND t.user_id = sm.slack_user_id
) conv_stats
-- Insight count
CROSS JOIN LATERAL (
  SELECT COUNT(*) as insight_count
  FROM member_insights mi
  WHERE mi.slack_user_id = sm.slack_user_id AND mi.is_current = TRUE
) insight_stats
WHERE sm.workos_user_id IS NULL
  AND sm.slack_is_bot = FALSE
  AND sm.slack_is_deleted = FALSE

UNION ALL

-- Email-only contacts (unchanged - no activity data to compute scores from)
SELECT
  'email_only' as contact_type,
  NULL as workos_user_id,
  ec.email,
  COALESCE(ec.display_name, SPLIT_PART(ec.email, '@', 1)) as full_name,
  NULL as first_name,
  NULL as last_name,

  -- No Slack identity
  NULL as slack_user_id,
  NULL as slack_display_name,
  NULL as slack_real_name,
  FALSE as is_slack_mapped,

  -- Organization if we've linked the domain
  ec.organization_id,
  o.name as organization_name,
  CASE WHEN o.subscription_status = 'active' THEN TRUE ELSE FALSE END as is_paying,

  -- No scores for email-only
  NULL::INTEGER as engagement_score,
  NULL::INTEGER as excitement_score,
  NULL::VARCHAR(20) as lifecycle_stage,
  NULL::INTEGER as slack_activity_score,
  NULL::INTEGER as email_engagement_score,
  NULL::INTEGER as conversation_score,
  NULL::INTEGER as community_score,
  NULL::TIMESTAMP WITH TIME ZONE as scores_computed_at,

  -- Activity
  NULL as last_slack_activity_at,
  NULL as last_conversation_at,
  NULL as last_outreach_at,

  -- Counts
  0 as insight_count,
  0 as conversation_count,

  ec.created_at,
  ec.updated_at

FROM email_contacts ec
LEFT JOIN organizations o ON o.workos_organization_id = ec.organization_id
WHERE NOT EXISTS (
  SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(ec.email)
)
AND NOT EXISTS (
  SELECT 1 FROM slack_user_mappings sm WHERE LOWER(sm.slack_email) = LOWER(ec.email)
);

COMMENT ON VIEW unified_contacts IS 'All contacts from users, Slack, and email with computed engagement scores';

-- Recreate the with_goals view
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
  uc.workos_user_id IS NOT NULL,
  uc.is_slack_mapped,
  COALESCE(uc.engagement_score, 0),
  COALESCE(uc.excitement_score, 0),
  uc.is_paying
) g;

COMMENT ON VIEW unified_contacts_with_goals IS 'Contacts with dynamically selected Addie goals';
