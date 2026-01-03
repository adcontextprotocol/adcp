-- Migration: 105_user_location.sql
-- Add location fields to users table for regional chapter matching
-- Also seeds outreach goals for location and chapter interest

-- =====================================================
-- USER LOCATION FIELDS
-- =====================================================

ALTER TABLE users
ADD COLUMN IF NOT EXISTS city VARCHAR(255),
ADD COLUMN IF NOT EXISTS country VARCHAR(100),
ADD COLUMN IF NOT EXISTS location_source VARCHAR(50),
ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMP WITH TIME ZONE;

-- Add constraint for location_source
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_location_source_check'
  ) THEN
    ALTER TABLE users
    ADD CONSTRAINT users_location_source_check
    CHECK (location_source IN ('manual', 'outreach', 'inferred'));
  END IF;
END $$;

-- Index for finding users by location
CREATE INDEX IF NOT EXISTS idx_users_city ON users(city) WHERE city IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_country ON users(country) WHERE country IS NOT NULL;

COMMENT ON COLUMN users.city IS 'User city (e.g., "New York", "London", "Austin")';
COMMENT ON COLUMN users.country IS 'User country (e.g., "USA", "United Kingdom")';
COMMENT ON COLUMN users.location_source IS 'How location was determined: manual, outreach, inferred';
COMMENT ON COLUMN users.location_updated_at IS 'When location was last updated';

-- =====================================================
-- UPDATE USER_PROFILE VIEW
-- =====================================================

-- Must drop and recreate because we're adding columns in the middle
DROP VIEW IF EXISTS user_profile;

CREATE VIEW user_profile AS
SELECT
  u.workos_user_id,
  u.email,
  u.first_name,
  u.last_name,
  u.engagement_score,
  u.excitement_score,
  u.lifecycle_stage,
  u.scores_computed_at,

  -- Location
  u.city,
  u.country,
  u.location_source,
  u.location_updated_at,

  -- Component scores
  u.slack_activity_score,
  u.email_engagement_score,
  u.conversation_score,
  u.community_score,

  -- Slack identity
  u.primary_slack_user_id,
  sm.slack_display_name,
  sm.slack_real_name,
  sm.last_slack_activity_at,

  -- Organization
  u.primary_organization_id,
  o.name as organization_name,
  o.subscription_status,

  -- Computed flags for Addie
  CASE
    WHEN u.engagement_score >= 50 OR u.excitement_score >= 50 THEN TRUE
    ELSE FALSE
  END as ready_for_membership_pitch,

  CASE
    WHEN u.engagement_score < 30 AND u.excitement_score < 30 THEN TRUE
    ELSE FALSE
  END as needs_engagement,

  u.created_at,
  u.updated_at

FROM users u
LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = u.primary_slack_user_id
LEFT JOIN organizations o ON o.workos_organization_id = u.primary_organization_id;

COMMENT ON VIEW user_profile IS 'Complete user profile with identities, scores, location, and Addie flags';

-- =====================================================
-- SEED INSIGHT TYPE FOR LOCATION
-- =====================================================

INSERT INTO member_insight_types (name, description, example_values, created_by)
VALUES (
  'location',
  'User primary city/location for regional chapter matching',
  ARRAY['New York', 'London', 'San Francisco', 'Austin', 'Los Angeles', 'Chicago', 'Miami', 'Sydney', 'Paris', 'Amsterdam'],
  'system'
) ON CONFLICT (name) DO NOTHING;

-- =====================================================
-- SEED OUTREACH GOAL FOR USER LOCATION
-- =====================================================

INSERT INTO insight_goals (
  name,
  question,
  insight_type_id,
  goal_type,
  is_enabled,
  priority,
  suggested_prompt_title,
  suggested_prompt_message,
  created_by
)
SELECT
  'User Location',
  'What city are you based in? We have regional chapters that host local events and discussions.',
  id,
  'persistent',
  TRUE,
  65,  -- Higher priority
  'Share your location',
  'Tell me where you are based so I can connect you with your local chapter!',
  'system'
FROM member_insight_types WHERE name = 'location'
ON CONFLICT DO NOTHING;

-- =====================================================
-- SEED INSIGHT TYPE FOR CHAPTER INTEREST
-- =====================================================

INSERT INTO member_insight_types (name, description, example_values, created_by)
VALUES (
  'chapter_interest',
  'Interest in regional chapters and local meetups',
  ARRAY['would attend', 'interested in starting', 'not interested', 'already member'],
  'system'
) ON CONFLICT (name) DO NOTHING;

-- =====================================================
-- SEED INSIGHT TYPE FOR EVENT ATTENDANCE
-- =====================================================

INSERT INTO member_insight_types (name, description, example_values, created_by)
VALUES (
  'event_attendance',
  'Industry events the user plans to attend',
  ARRAY['CES 2026', 'Cannes Lions 2026', 'AdExchanger Conference', 'POSSIBLE Miami'],
  'system'
) ON CONFLICT (name) DO NOTHING;
