-- Migration: 113_engagement_level_function.sql
-- Adds engagement_level column and function to compute it consistently
-- This aligns the list page with the detail page's priority-based calculation

-- Add engagement_level column if it doesn't exist
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS engagement_level INTEGER DEFAULT 1;

-- =====================================================
-- COMPUTE ORGANIZATION ENGAGEMENT LEVEL (PRIORITY-BASED)
-- =====================================================
-- This mirrors the detail page logic exactly for consistency

CREATE OR REPLACE FUNCTION compute_org_engagement_level(p_workos_organization_id VARCHAR(255))
RETURNS TABLE (
  engagement_level INTEGER,
  engagement_reasons TEXT[]
) AS $$
DECLARE
  v_engagement_level INTEGER := 1;
  v_engagement_reasons TEXT[] := ARRAY[]::TEXT[];

  v_interest_level VARCHAR(20);
  v_interest_level_set_by VARCHAR(255);
  v_invoice_requested_at TIMESTAMP;
  v_working_group_count INTEGER;
  v_has_member_profile BOOLEAN;
  v_login_count_30d INTEGER;
  v_member_count INTEGER;
  v_email_click_count_30d INTEGER;
  v_has_recent_activity BOOLEAN;
BEGIN
  -- Fetch organization data
  SELECT
    interest_level,
    interest_level_set_by,
    invoice_requested_at
  INTO
    v_interest_level,
    v_interest_level_set_by,
    v_invoice_requested_at
  FROM organizations
  WHERE workos_organization_id = p_workos_organization_id;

  -- Working group count
  SELECT COUNT(DISTINCT wgm.working_group_id)
  INTO v_working_group_count
  FROM working_group_memberships wgm
  WHERE wgm.workos_organization_id = p_workos_organization_id
    AND wgm.status = 'active';

  -- Has member profile
  SELECT EXISTS(
    SELECT 1 FROM member_profiles WHERE workos_organization_id = p_workos_organization_id
  ) INTO v_has_member_profile;

  -- Login count (last 30 days)
  SELECT COUNT(*)
  INTO v_login_count_30d
  FROM org_activities
  WHERE organization_id = p_workos_organization_id
    AND activity_type = 'dashboard_login'
    AND activity_date > NOW() - INTERVAL '30 days';

  -- Member count
  SELECT COUNT(*)
  INTO v_member_count
  FROM organization_memberships
  WHERE workos_organization_id = p_workos_organization_id;

  -- Email click count (last 30 days)
  SELECT COUNT(*)
  INTO v_email_click_count_30d
  FROM email_clicks ec
  JOIN email_events ee ON ee.id = ec.email_event_id
  WHERE ee.workos_organization_id = p_workos_organization_id
    AND ec.clicked_at > NOW() - INTERVAL '30 days';

  -- Has recent activity (last 30 days)
  SELECT EXISTS(
    SELECT 1 FROM org_activities
    WHERE organization_id = p_workos_organization_id
      AND activity_date > NOW() - INTERVAL '30 days'
  ) INTO v_has_recent_activity;

  -- Priority-based scoring (matches detail page exactly)
  IF v_interest_level = 'very_high' THEN
    v_engagement_level := 5;
    v_engagement_reasons := array_append(v_engagement_reasons,
      'Interest: Very High (' || COALESCE(v_interest_level_set_by, 'admin') || ')');
  ELSIF v_interest_level = 'high' THEN
    v_engagement_level := 4;
    v_engagement_reasons := array_append(v_engagement_reasons,
      'Interest: High (' || COALESCE(v_interest_level_set_by, 'admin') || ')');
  ELSIF v_invoice_requested_at IS NOT NULL THEN
    v_engagement_level := 5;
    v_engagement_reasons := array_append(v_engagement_reasons, 'Requested invoice');
  ELSIF v_working_group_count > 0 THEN
    v_engagement_level := 4;
    v_engagement_reasons := array_append(v_engagement_reasons,
      'In ' || v_working_group_count || ' working group(s)');
  ELSIF v_has_member_profile THEN
    v_engagement_level := 4;
    v_engagement_reasons := array_append(v_engagement_reasons, 'Member profile configured');
  ELSIF v_login_count_30d > 3 THEN
    v_engagement_level := 3;
    v_engagement_reasons := array_append(v_engagement_reasons,
      v_login_count_30d || ' dashboard logins (30d)');
  ELSIF v_member_count > 0 THEN
    v_engagement_level := 3;
    v_engagement_reasons := array_append(v_engagement_reasons,
      v_member_count || ' team member(s)');
  ELSIF v_email_click_count_30d > 0 THEN
    v_engagement_level := 2;
    v_engagement_reasons := array_append(v_engagement_reasons,
      v_email_click_count_30d || ' email clicks (30d)');
  ELSIF v_login_count_30d > 0 THEN
    v_engagement_level := 2;
    v_engagement_reasons := array_append(v_engagement_reasons,
      v_login_count_30d || ' dashboard login(s) (30d)');
  ELSIF v_has_recent_activity THEN
    v_engagement_level := 2;
    v_engagement_reasons := array_append(v_engagement_reasons, 'Recent contact');
  END IF;

  -- Handle low/medium interest levels - cap engagement
  IF v_interest_level = 'low' THEN
    v_engagement_level := LEAST(v_engagement_level, 2);
    v_engagement_reasons := array_prepend(
      'Interest: Low (' || COALESCE(v_interest_level_set_by, 'admin') || ')',
      v_engagement_reasons);
  ELSIF v_interest_level = 'medium' THEN
    v_engagement_level := LEAST(v_engagement_level, 3);
    v_engagement_reasons := array_prepend(
      'Interest: Medium (' || COALESCE(v_interest_level_set_by, 'admin') || ')',
      v_engagement_reasons);
  END IF;

  -- Default reason if none set
  IF array_length(v_engagement_reasons, 1) IS NULL THEN
    v_engagement_reasons := ARRAY['New prospect'];
  END IF;

  RETURN QUERY SELECT v_engagement_level, v_engagement_reasons;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION compute_org_engagement_level IS
  'Computes priority-based engagement level (1-5) matching detail page logic';

-- =====================================================
-- UPDATE SINGLE ORGANIZATION ENGAGEMENT LEVEL
-- =====================================================

CREATE OR REPLACE FUNCTION update_org_engagement_level(p_workos_organization_id VARCHAR(255))
RETURNS VOID AS $$
DECLARE
  v_result RECORD;
BEGIN
  SELECT * INTO v_result FROM compute_org_engagement_level(p_workos_organization_id);

  UPDATE organizations SET
    engagement_level = v_result.engagement_level,
    updated_at = NOW()
  WHERE workos_organization_id = p_workos_organization_id;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- UPDATE update_org_engagement TO ALSO SET engagement_level
-- =====================================================

CREATE OR REPLACE FUNCTION update_org_engagement(p_workos_organization_id VARCHAR(255))
RETURNS VOID AS $$
DECLARE
  v_scores RECORD;
  v_level RECORD;
BEGIN
  -- Compute scores (additive 0-100)
  SELECT * INTO v_scores FROM compute_org_engagement_score(p_workos_organization_id);

  -- Compute level (priority-based 1-5)
  SELECT * INTO v_level FROM compute_org_engagement_level(p_workos_organization_id);

  -- Update organization with both
  UPDATE organizations SET
    engagement_score = v_scores.engagement_score,
    engagement_level = v_level.engagement_level,
    org_scores_computed_at = NOW(),
    updated_at = NOW()
  WHERE workos_organization_id = p_workos_organization_id;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- BATCH UPDATE ALL ORGANIZATION ENGAGEMENT LEVELS
-- =====================================================

CREATE OR REPLACE FUNCTION update_all_org_engagement_levels()
RETURNS INTEGER AS $$
DECLARE
  v_org RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_org IN
    SELECT workos_organization_id FROM organizations
    WHERE is_personal IS NOT TRUE
  LOOP
    PERFORM update_org_engagement_level(v_org.workos_organization_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- Run initial update for all organizations
SELECT update_all_org_engagement_levels();

-- Create index for hot prospects query using engagement_level
CREATE INDEX IF NOT EXISTS idx_organizations_engagement_level
ON organizations(engagement_level DESC)
WHERE is_personal IS NOT TRUE;
