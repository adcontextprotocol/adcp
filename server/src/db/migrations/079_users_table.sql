-- Migration: 074_users_table.sql
-- Canonical users table for unified person management
--
-- This creates a central users table that:
-- 1. Is the source of truth for all AAO users (synced from WorkOS)
-- 2. Stores computed engagement and excitement scores
-- 3. Tracks lifecycle stage for personalized interactions
-- 4. Links to Slack, email, and organization identities

-- =====================================================
-- USERS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS users (
  -- Primary key from WorkOS
  workos_user_id VARCHAR(255) PRIMARY KEY,

  -- Cached from WorkOS (updated via webhooks)
  email VARCHAR(255) NOT NULL,
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  email_verified BOOLEAN DEFAULT FALSE,

  -- Engagement scoring (computed from activity data)
  -- Scale: 0-100, computed periodically
  engagement_score INTEGER DEFAULT 0 CHECK (engagement_score >= 0 AND engagement_score <= 100),
  excitement_score INTEGER DEFAULT 0 CHECK (excitement_score >= 0 AND excitement_score <= 100),

  -- Lifecycle stage for dynamic goal selection
  -- new: just created, minimal activity
  -- active: regular engagement
  -- engaged: high engagement, participating in community
  -- champion: very high engagement + excitement, refers others
  -- at_risk: was engaged, now dropping off
  lifecycle_stage VARCHAR(20) DEFAULT 'new'
    CHECK (lifecycle_stage IN ('new', 'active', 'engaged', 'champion', 'at_risk')),

  -- When scores were last computed
  scores_computed_at TIMESTAMP WITH TIME ZONE,

  -- Component scores for debugging/transparency
  -- These break down what contributes to the overall scores
  slack_activity_score INTEGER DEFAULT 0,     -- From slack_activity_daily
  email_engagement_score INTEGER DEFAULT 0,   -- From email_events
  conversation_score INTEGER DEFAULT 0,       -- From Addie conversations
  community_score INTEGER DEFAULT 0,          -- Working groups, events, etc.

  -- Quick lookup for primary identities
  primary_slack_user_id VARCHAR(255),         -- Most active Slack identity
  primary_organization_id VARCHAR(255),       -- Primary org (if in multiple)

  -- Timestamps from WorkOS
  workos_created_at TIMESTAMP WITH TIME ZONE,
  workos_updated_at TIMESTAMP WITH TIME ZONE,

  -- Our timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_engagement ON users(engagement_score DESC);
CREATE INDEX IF NOT EXISTS idx_users_excitement ON users(excitement_score DESC);
CREATE INDEX IF NOT EXISTS idx_users_lifecycle ON users(lifecycle_stage);
-- Index for finding users who need score recomputation
-- Note: Can't use NOW() in index predicate, so just index on the column
-- and filter in queries
CREATE INDEX IF NOT EXISTS idx_users_scores_stale ON users(scores_computed_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_users_primary_slack ON users(primary_slack_user_id)
  WHERE primary_slack_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_primary_org ON users(primary_organization_id)
  WHERE primary_organization_id IS NOT NULL;

COMMENT ON TABLE users IS 'Canonical user records synced from WorkOS with computed engagement scores';
COMMENT ON COLUMN users.engagement_score IS 'Overall engagement 0-100, computed from activity across channels';
COMMENT ON COLUMN users.excitement_score IS 'Enthusiasm/interest 0-100, computed from conversation sentiment';
COMMENT ON COLUMN users.lifecycle_stage IS 'Current stage in member journey for personalized outreach';

-- =====================================================
-- ADD FOREIGN KEY REFERENCES
-- =====================================================
-- Note: We don't enforce FK constraints since users may exist in
-- slack_user_mappings/email_contacts before they have an AAO account.
-- The workos_user_id columns already exist, we just document the relationship.

-- Add index on slack_user_mappings for faster user lookups
CREATE INDEX IF NOT EXISTS idx_slack_mapping_workos_user
  ON slack_user_mappings(workos_user_id)
  WHERE workos_user_id IS NOT NULL;

-- Add index on email_contacts for faster user lookups
CREATE INDEX IF NOT EXISTS idx_email_contacts_workos_user
  ON email_contacts(workos_user_id)
  WHERE workos_user_id IS NOT NULL;

-- =====================================================
-- ORGANIZATION SCORING COLUMNS
-- =====================================================
-- Add excitement_score to organizations (engagement_score already exists)

ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS excitement_score INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS champion_workos_user_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS org_lifecycle_stage VARCHAR(20) DEFAULT 'prospect',
ADD COLUMN IF NOT EXISTS org_scores_computed_at TIMESTAMP WITH TIME ZONE;

-- Add constraint for org_lifecycle_stage
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_lifecycle_stage_check'
  ) THEN
    ALTER TABLE organizations
    ADD CONSTRAINT organizations_lifecycle_stage_check
    CHECK (org_lifecycle_stage IN ('prospect', 'evaluating', 'trial', 'paying', 'churned', 'at_risk'));
  END IF;
END $$;

COMMENT ON COLUMN organizations.excitement_score IS 'Max excitement score among org members';
COMMENT ON COLUMN organizations.champion_workos_user_id IS 'User with highest combined engagement+excitement';
COMMENT ON COLUMN organizations.org_lifecycle_stage IS 'Organization lifecycle: prospect->evaluating->trial->paying';

-- =====================================================
-- BACKFILL USERS FROM EXISTING DATA
-- =====================================================
-- Create user records for anyone who already has a workos_user_id
-- in organization_memberships (which has email, first_name, last_name)

INSERT INTO users (
  workos_user_id,
  email,
  first_name,
  last_name,
  created_at
)
SELECT DISTINCT ON (workos_user_id)
  workos_user_id,
  email,
  first_name,
  last_name,
  COALESCE(created_at, NOW())
FROM organization_memberships
WHERE workos_user_id IS NOT NULL
ON CONFLICT (workos_user_id) DO UPDATE SET
  email = EXCLUDED.email,
  first_name = EXCLUDED.first_name,
  last_name = EXCLUDED.last_name,
  updated_at = NOW();

-- =====================================================
-- LINK SLACK USERS TO USERS TABLE
-- =====================================================
-- Update users.primary_slack_user_id for users who have Slack mappings

UPDATE users u
SET primary_slack_user_id = (
  SELECT slack_user_id
  FROM slack_user_mappings sm
  WHERE sm.workos_user_id = u.workos_user_id
    AND sm.mapping_status = 'mapped'
  ORDER BY sm.last_slack_activity_at DESC NULLS LAST
  LIMIT 1
),
updated_at = NOW()
WHERE EXISTS (
  SELECT 1 FROM slack_user_mappings sm
  WHERE sm.workos_user_id = u.workos_user_id
    AND sm.mapping_status = 'mapped'
);

-- =====================================================
-- LINK USERS TO PRIMARY ORGANIZATION
-- =====================================================
-- Set primary_organization_id (prefer paying orgs, then most recent)

UPDATE users u
SET primary_organization_id = (
  SELECT om.workos_organization_id
  FROM organization_memberships om
  JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
  WHERE om.workos_user_id = u.workos_user_id
  ORDER BY
    CASE WHEN o.subscription_status = 'active' THEN 0 ELSE 1 END,
    om.created_at DESC
  LIMIT 1
),
updated_at = NOW()
WHERE EXISTS (
  SELECT 1 FROM organization_memberships om
  WHERE om.workos_user_id = u.workos_user_id
);

-- =====================================================
-- VIEW: User with all identities and scores
-- =====================================================

CREATE OR REPLACE VIEW user_profile AS
SELECT
  u.workos_user_id,
  u.email,
  u.first_name,
  u.last_name,
  u.engagement_score,
  u.excitement_score,
  u.lifecycle_stage,
  u.scores_computed_at,

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

COMMENT ON VIEW user_profile IS 'Complete user profile with identities, scores, and Addie flags';

-- =====================================================
-- VIEW: Organization with aggregated member scores
-- =====================================================

CREATE OR REPLACE VIEW organization_profile AS
SELECT
  o.workos_organization_id,
  o.name,
  o.company_type,
  o.subscription_status,
  o.interest_level,
  o.engagement_score as org_engagement_score,
  o.excitement_score as org_excitement_score,
  o.org_lifecycle_stage,
  o.champion_workos_user_id,

  -- Champion details
  champion.email as champion_email,
  champion.first_name as champion_first_name,
  champion.last_name as champion_last_name,
  champion.engagement_score as champion_engagement,
  champion.excitement_score as champion_excitement,

  -- Member stats
  (SELECT COUNT(*) FROM organization_memberships om WHERE om.workos_organization_id = o.workos_organization_id) as member_count,
  (SELECT AVG(u.engagement_score) FROM users u
   JOIN organization_memberships om ON om.workos_user_id = u.workos_user_id
   WHERE om.workos_organization_id = o.workos_organization_id) as avg_member_engagement,
  (SELECT MAX(u.excitement_score) FROM users u
   JOIN organization_memberships om ON om.workos_user_id = u.workos_user_id
   WHERE om.workos_organization_id = o.workos_organization_id) as max_member_excitement,

  -- Computed flags
  CASE
    WHEN o.subscription_status = 'active' THEN FALSE
    WHEN o.engagement_score >= 50 OR o.excitement_score >= 50 THEN TRUE
    ELSE FALSE
  END as ready_for_sales,

  CASE
    WHEN o.subscription_status = 'active' AND o.engagement_score < 30 THEN TRUE
    ELSE FALSE
  END as at_risk_churn,

  o.created_at,
  o.updated_at

FROM organizations o
LEFT JOIN users champion ON champion.workos_user_id = o.champion_workos_user_id;

COMMENT ON VIEW organization_profile IS 'Organization with aggregated member scores and sales flags';
