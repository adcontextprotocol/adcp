-- Migration: 109_org_engagement_scoring.sql
-- Enhanced organization-level engagement scoring for prospects
--
-- This replaces the simple 1-5 priority-based scoring with an additive system
-- that considers ALL engagement signals, not just the highest priority one.
--
-- Scoring Components (0-100 total):
-- - Slack users (0-20): People from this org in Slack
-- - Team members (0-15): Web users with organization memberships
-- - Working groups (0-15): Active working group memberships
-- - Recent activity (0-15): Logged activities in last 30 days
-- - Email engagement (0-15): Email opens/clicks in last 30 days
-- - Event interest (0-10): Event attendance or interest
-- - Interest level (0-10): Manually set interest level
--
-- Hot prospect threshold: engagement_score >= 30

-- =====================================================
-- COMPUTE ORGANIZATION ENGAGEMENT SCORE (ADDITIVE)
-- =====================================================

CREATE OR REPLACE FUNCTION compute_org_engagement_score(p_workos_organization_id VARCHAR(255))
RETURNS TABLE (
  engagement_score INTEGER,
  slack_user_score INTEGER,
  team_member_score INTEGER,
  working_group_score INTEGER,
  activity_score INTEGER,
  email_score INTEGER,
  event_score INTEGER,
  interest_score INTEGER,
  engagement_reasons TEXT[]
) AS $$
DECLARE
  v_slack_user_score INTEGER := 0;
  v_team_member_score INTEGER := 0;
  v_wg_score INTEGER := 0;
  v_activity_score INTEGER := 0;
  v_email_score INTEGER := 0;
  v_event_score INTEGER := 0;
  v_interest_score INTEGER := 0;
  v_total_score INTEGER := 0;
  v_reasons TEXT[] := ARRAY[]::TEXT[];

  v_slack_user_count INTEGER;
  v_team_member_count INTEGER;
  v_wg_count INTEGER;
  v_activity_count INTEGER;
  v_email_open_count INTEGER;
  v_email_click_count INTEGER;
  v_event_attending_count INTEGER;
  v_event_interested_count INTEGER;
  v_interest_level VARCHAR(20);
BEGIN
  -- =========================================
  -- SLACK USERS (0-20 points)
  -- =========================================
  -- Count Slack users associated with this org (via email domain or membership)
  SELECT COUNT(DISTINCT sm.slack_user_id)
  INTO v_slack_user_count
  FROM slack_user_mappings sm
  LEFT JOIN organization_memberships om ON om.workos_user_id = sm.workos_user_id
  LEFT JOIN organization_domains od ON od.workos_organization_id = p_workos_organization_id
    AND sm.slack_email ILIKE '%@' || od.domain
  WHERE (om.workos_organization_id = p_workos_organization_id
         OR od.workos_organization_id IS NOT NULL)
    AND sm.slack_is_bot IS NOT TRUE;

  IF v_slack_user_count > 0 THEN
    -- 5 points per Slack user, max 20
    v_slack_user_score := LEAST(20, v_slack_user_count * 5);
    v_reasons := array_append(v_reasons, v_slack_user_count || ' Slack user(s)');
  END IF;

  -- =========================================
  -- TEAM MEMBERS (0-15 points)
  -- =========================================
  -- Count web users with organization memberships
  SELECT COUNT(*)
  INTO v_team_member_count
  FROM organization_memberships
  WHERE workos_organization_id = p_workos_organization_id;

  IF v_team_member_count > 0 THEN
    -- 5 points per member, max 15
    v_team_member_score := LEAST(15, v_team_member_count * 5);
    v_reasons := array_append(v_reasons, v_team_member_count || ' team member(s)');
  END IF;

  -- =========================================
  -- WORKING GROUPS (0-15 points)
  -- =========================================
  -- Count active working group memberships (excluding event groups)
  SELECT COUNT(DISTINCT wgm.working_group_id)
  INTO v_wg_count
  FROM working_group_memberships wgm
  JOIN working_groups wg ON wg.id = wgm.working_group_id
  WHERE wgm.workos_organization_id = p_workos_organization_id
    AND wgm.status = 'active'
    AND (wg.committee_type IS NULL OR wg.committee_type != 'event');

  IF v_wg_count > 0 THEN
    -- 5 points per working group, max 15
    v_wg_score := LEAST(15, v_wg_count * 5);
    v_reasons := array_append(v_reasons, 'In ' || v_wg_count || ' working group(s)');
  END IF;

  -- =========================================
  -- RECENT ACTIVITY (0-15 points)
  -- =========================================
  -- Count activities in last 30 days
  SELECT COUNT(*)
  INTO v_activity_count
  FROM org_activities
  WHERE organization_id = p_workos_organization_id
    AND activity_date >= CURRENT_DATE - INTERVAL '30 days';

  IF v_activity_count > 0 THEN
    -- 3 points per activity, max 15
    v_activity_score := LEAST(15, v_activity_count * 3);
    v_reasons := array_append(v_reasons, v_activity_count || ' recent activity(ies)');
  END IF;

  -- =========================================
  -- EMAIL ENGAGEMENT (0-15 points)
  -- =========================================
  -- Count email opens and clicks for org members in last 30 days
  SELECT
    COUNT(DISTINCT CASE WHEN ee.opened_at IS NOT NULL THEN ee.tracking_id END),
    COUNT(DISTINCT CASE WHEN ee.first_clicked_at IS NOT NULL THEN ee.tracking_id END)
  INTO v_email_open_count, v_email_click_count
  FROM email_events ee
  JOIN organization_memberships om ON om.workos_user_id = ee.workos_user_id
  WHERE om.workos_organization_id = p_workos_organization_id
    AND ee.sent_at >= NOW() - INTERVAL '30 days';

  IF v_email_open_count > 0 OR v_email_click_count > 0 THEN
    -- 2 points per open (max 6), 3 points per click (max 9)
    v_email_score := LEAST(6, v_email_open_count * 2) + LEAST(9, v_email_click_count * 3);
    IF v_email_click_count > 0 THEN
      v_reasons := array_append(v_reasons, v_email_click_count || ' email click(s)');
    ELSIF v_email_open_count > 0 THEN
      v_reasons := array_append(v_reasons, v_email_open_count || ' email open(s)');
    END IF;
  END IF;

  -- =========================================
  -- EVENT INTEREST (0-10 points)
  -- =========================================
  -- Count event attendance/interest
  SELECT
    COUNT(*) FILTER (WHERE wgm.interest_level = 'attending' OR wgm.interest_level = 'attended'),
    COUNT(*) FILTER (WHERE wgm.interest_level = 'interested' OR wgm.interest_level = 'maybe')
  INTO v_event_attending_count, v_event_interested_count
  FROM working_group_memberships wgm
  JOIN working_groups wg ON wg.id = wgm.working_group_id
  WHERE wgm.workos_organization_id = p_workos_organization_id
    AND wgm.status = 'active'
    AND wg.committee_type = 'event';

  IF v_event_attending_count > 0 THEN
    -- 5 points per attending, max 10
    v_event_score := LEAST(10, v_event_attending_count * 5);
    v_reasons := array_append(v_reasons, v_event_attending_count || ' event(s) attending');
  ELSIF v_event_interested_count > 0 THEN
    -- 3 points per interested, max 6
    v_event_score := LEAST(6, v_event_interested_count * 3);
    v_reasons := array_append(v_reasons, v_event_interested_count || ' event(s) interested');
  END IF;

  -- =========================================
  -- INTEREST LEVEL (0-10 points)
  -- =========================================
  -- Use manually set interest level
  SELECT interest_level
  INTO v_interest_level
  FROM organizations
  WHERE workos_organization_id = p_workos_organization_id;

  CASE v_interest_level
    WHEN 'very_high' THEN
      v_interest_score := 10;
      v_reasons := array_append(v_reasons, 'Interest: Very High');
    WHEN 'high' THEN
      v_interest_score := 7;
      v_reasons := array_append(v_reasons, 'Interest: High');
    WHEN 'medium' THEN
      v_interest_score := 4;
      v_reasons := array_append(v_reasons, 'Interest: Medium');
    WHEN 'low' THEN
      v_interest_score := 0;
      -- Low interest caps the score - handled below
    ELSE
      v_interest_score := 0;
  END CASE;

  -- Note: Pending invoices are checked via Stripe API in the application layer
  -- and displayed in engagement_reasons by the JS code, not in this SQL function.

  -- =========================================
  -- CALCULATE TOTAL (max 100)
  -- =========================================
  v_total_score := v_slack_user_score + v_team_member_score + v_wg_score +
                   v_activity_score + v_email_score + v_event_score + v_interest_score;

  -- Cap at 100
  v_total_score := LEAST(100, v_total_score);

  -- Low interest caps the total score at 20
  IF v_interest_level = 'low' THEN
    v_total_score := LEAST(20, v_total_score);
    v_reasons := array_prepend('Interest: Low (capped)', v_reasons);
  END IF;

  RETURN QUERY SELECT
    v_total_score,
    v_slack_user_score,
    v_team_member_score,
    v_wg_score,
    v_activity_score,
    v_email_score,
    v_event_score,
    v_interest_score,
    v_reasons;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION compute_org_engagement_score IS 'Computes additive engagement score (0-100) for an organization based on all engagement signals';

-- =====================================================
-- UPDATE SINGLE ORGANIZATION ENGAGEMENT
-- =====================================================

CREATE OR REPLACE FUNCTION update_org_engagement(p_workos_organization_id VARCHAR(255))
RETURNS VOID AS $$
DECLARE
  v_scores RECORD;
BEGIN
  -- Compute scores
  SELECT * INTO v_scores FROM compute_org_engagement_score(p_workos_organization_id);

  -- Update organization
  UPDATE organizations SET
    engagement_score = v_scores.engagement_score,
    org_scores_computed_at = NOW(),
    updated_at = NOW()
  WHERE workos_organization_id = p_workos_organization_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_org_engagement IS 'Updates engagement score for a single organization';

-- =====================================================
-- BATCH UPDATE ALL ORGANIZATION ENGAGEMENT SCORES
-- =====================================================

CREATE OR REPLACE FUNCTION update_all_org_engagement_scores()
RETURNS INTEGER AS $$
DECLARE
  v_org RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_org IN
    SELECT workos_organization_id FROM organizations
    WHERE is_personal IS NOT TRUE
  LOOP
    PERFORM update_org_engagement(v_org.workos_organization_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_all_org_engagement_scores IS 'Updates engagement scores for all non-personal organizations';

-- =====================================================
-- UPDATE STALE ORGANIZATION SCORES (for scheduled jobs)
-- =====================================================

CREATE OR REPLACE FUNCTION update_stale_org_engagement_scores(p_max_orgs INTEGER DEFAULT 100)
RETURNS INTEGER AS $$
DECLARE
  v_org RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_org IN
    SELECT workos_organization_id
    FROM organizations
    WHERE is_personal IS NOT TRUE
      AND (org_scores_computed_at IS NULL
           OR org_scores_computed_at < NOW() - INTERVAL '1 day')
    ORDER BY org_scores_computed_at NULLS FIRST
    LIMIT p_max_orgs
  LOOP
    PERFORM update_org_engagement(v_org.workos_organization_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_stale_org_engagement_scores IS 'Batch updates scores for orgs with stale data';

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

-- Index for hot prospects query (engagement_score >= 30, non-paying)
CREATE INDEX IF NOT EXISTS idx_organizations_engagement_score
ON organizations(engagement_score DESC NULLS LAST)
WHERE is_personal IS NOT TRUE;

-- Index for stale score updates
CREATE INDEX IF NOT EXISTS idx_organizations_scores_computed_at
ON organizations(org_scores_computed_at NULLS FIRST)
WHERE is_personal IS NOT TRUE;

-- =====================================================
-- RUN INITIAL SCORING FOR ALL ORGANIZATIONS
-- =====================================================

SELECT update_all_org_engagement_scores();
