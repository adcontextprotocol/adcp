-- Remove deprecated org_lifecycle_stage column
--
-- This field was computed by update_organization_scores() but:
-- 1. Became stale between score updates
-- 2. Didn't match actual pipeline states (contacted, responded, interested, negotiating)
-- 3. Caused confusion (e.g., showing "prospect" for paid members)
-- 4. Was never actually read by any application code
--
-- Lifecycle stage is now computed at runtime by computeLifecycleStage() in TypeScript,
-- which uses subscription_status, prospect_status, and invoice_requested_at for accuracy.

-- Step 1: Update update_organization_scores() to not set org_lifecycle_stage
CREATE OR REPLACE FUNCTION update_organization_scores(p_workos_organization_id VARCHAR(255))
RETURNS VOID AS $$
DECLARE
  v_engagement INTEGER;
  v_excitement INTEGER;
  v_champion_id VARCHAR(255);
BEGIN
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

  -- Update organization (no longer setting org_lifecycle_stage)
  UPDATE organizations SET
    engagement_score = COALESCE(v_engagement, 0),
    excitement_score = COALESCE(v_excitement, 0),
    champion_workos_user_id = v_champion_id,
    org_scores_computed_at = NOW(),
    updated_at = NOW()
  WHERE workos_organization_id = p_workos_organization_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_organization_scores IS 'Aggregates member scores to organization level';

-- Step 2: Drop the view that references the column we want to remove
DROP VIEW IF EXISTS organization_profile;

-- Step 3: Drop the column and its constraint
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_lifecycle_stage_check;
ALTER TABLE organizations DROP COLUMN IF EXISTS org_lifecycle_stage;

-- Step 4: Recreate organization_profile view without org_lifecycle_stage
CREATE VIEW organization_profile AS
SELECT
  o.workos_organization_id,
  o.name,
  o.company_type,
  o.subscription_status,
  o.interest_level,
  o.engagement_score as org_engagement_score,
  o.excitement_score as org_excitement_score,
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
