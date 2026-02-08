-- Migration: 207_backfill_org_knowledge.sql
-- Backfill org_knowledge from existing organization columns.
--
-- This populates the provenance layer with data that already exists in the organizations
-- table, tagging each with the best-guess source based on how it got there.
--
-- Uses WHERE NOT EXISTS guards for idempotency (safe to re-run).

-- =====================================================
-- BACKFILL: company_type (source unknown, tag as 'admin_set')
-- =====================================================
-- company_type was set during onboarding or by admins. We can't distinguish,
-- so we tag as admin_set with medium confidence.

INSERT INTO org_knowledge (workos_organization_id, attribute, value, source, confidence, set_by_description, set_at)
SELECT
  workos_organization_id,
  'company_type',
  company_type,
  'admin_set',
  'medium',
  'backfill from organizations.company_type (original source unknown)',
  COALESCE(updated_at, created_at)
FROM organizations o
WHERE company_type IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM org_knowledge ok
    WHERE ok.workos_organization_id = o.workos_organization_id
      AND ok.attribute = 'company_type'
      AND ok.is_current = TRUE
  );

-- =====================================================
-- BACKFILL: revenue_tier (source unknown, tag as 'admin_set')
-- =====================================================

INSERT INTO org_knowledge (workos_organization_id, attribute, value, source, confidence, set_by_description, set_at)
SELECT
  workos_organization_id,
  'revenue_tier',
  revenue_tier,
  'admin_set',
  'medium',
  'backfill from organizations.revenue_tier (original source unknown)',
  COALESCE(updated_at, created_at)
FROM organizations o
WHERE revenue_tier IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM org_knowledge ok
    WHERE ok.workos_organization_id = o.workos_organization_id
      AND ok.attribute = 'revenue_tier'
      AND ok.is_current = TRUE
  );

-- =====================================================
-- BACKFILL: interest_level (admin-set, has provenance)
-- =====================================================

INSERT INTO org_knowledge (workos_organization_id, attribute, value, source, confidence, set_by_description, set_at)
SELECT
  workos_organization_id,
  'interest_level',
  interest_level,
  'admin_set',
  'high',
  COALESCE('backfill: set by ' || interest_level_set_by, 'backfill from organizations.interest_level'),
  COALESCE(interest_level_set_at, updated_at, created_at)
FROM organizations o
WHERE interest_level IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM org_knowledge ok
    WHERE ok.workos_organization_id = o.workos_organization_id
      AND ok.attribute = 'interest_level'
      AND ok.is_current = TRUE
  );

-- =====================================================
-- BACKFILL: enrichment data (well-provenanced)
-- =====================================================

-- Industry from enrichment
INSERT INTO org_knowledge (workos_organization_id, attribute, value, source, confidence, set_by_description, set_at, verified_at)
SELECT
  workos_organization_id,
  'industry',
  enrichment_industry,
  'enrichment',
  'medium',
  COALESCE('backfill: ' || enrichment_source, 'backfill from enrichment'),
  COALESCE(enrichment_at, updated_at),
  enrichment_at
FROM organizations o
WHERE enrichment_industry IS NOT NULL
  AND enrichment_source IS NOT NULL
  AND enrichment_source != 'lusha_not_found'
  AND NOT EXISTS (
    SELECT 1 FROM org_knowledge ok
    WHERE ok.workos_organization_id = o.workos_organization_id
      AND ok.attribute = 'industry'
      AND ok.is_current = TRUE
  );

-- Employee count from enrichment
INSERT INTO org_knowledge (workos_organization_id, attribute, value, source, confidence, set_by_description, set_at, verified_at)
SELECT
  workos_organization_id,
  'employee_count',
  enrichment_employee_count::TEXT,
  'enrichment',
  'medium',
  COALESCE('backfill: ' || enrichment_source, 'backfill from enrichment'),
  COALESCE(enrichment_at, updated_at),
  enrichment_at
FROM organizations o
WHERE enrichment_employee_count IS NOT NULL
  AND enrichment_source IS NOT NULL
  AND enrichment_source != 'lusha_not_found'
  AND NOT EXISTS (
    SELECT 1 FROM org_knowledge ok
    WHERE ok.workos_organization_id = o.workos_organization_id
      AND ok.attribute = 'employee_count'
      AND ok.is_current = TRUE
  );

-- Revenue from enrichment
INSERT INTO org_knowledge (workos_organization_id, attribute, value, source, confidence, set_by_description, set_at, verified_at)
SELECT
  workos_organization_id,
  'revenue',
  enrichment_revenue::TEXT,
  'enrichment',
  'medium',
  COALESCE('backfill: ' || enrichment_source, 'backfill from enrichment'),
  COALESCE(enrichment_at, updated_at),
  enrichment_at
FROM organizations o
WHERE enrichment_revenue IS NOT NULL
  AND enrichment_source IS NOT NULL
  AND enrichment_source != 'lusha_not_found'
  AND NOT EXISTS (
    SELECT 1 FROM org_knowledge ok
    WHERE ok.workos_organization_id = o.workos_organization_id
      AND ok.attribute = 'revenue'
      AND ok.is_current = TRUE
  );

-- Description from enrichment
INSERT INTO org_knowledge (workos_organization_id, attribute, value, source, confidence, set_by_description, set_at, verified_at)
SELECT
  workos_organization_id,
  'description',
  enrichment_description,
  'enrichment',
  'medium',
  COALESCE('backfill: ' || enrichment_source, 'backfill from enrichment'),
  COALESCE(enrichment_at, updated_at),
  enrichment_at
FROM organizations o
WHERE enrichment_description IS NOT NULL
  AND enrichment_source IS NOT NULL
  AND enrichment_source != 'lusha_not_found'
  AND NOT EXISTS (
    SELECT 1 FROM org_knowledge ok
    WHERE ok.workos_organization_id = o.workos_organization_id
      AND ok.attribute = 'description'
      AND ok.is_current = TRUE
  );

-- =====================================================
-- BACKFILL: member_insights -> org_knowledge
-- =====================================================
-- Aggregate current member insights to org level.
-- For each org, take the most recent value per insight type from its members.

INSERT INTO org_knowledge (workos_organization_id, attribute, value, source, confidence, set_by_description, set_at, source_reference)
SELECT DISTINCT ON (om.workos_organization_id, mit.name)
  om.workos_organization_id,
  mit.name,
  mi.value,
  'addie_inferred',
  mi.confidence,
  'backfill: aggregated from member_insights (most recent per org)',
  mi.created_at,
  'member_insight_id:' || mi.id::TEXT
FROM member_insights mi
JOIN member_insight_types mit ON mi.insight_type_id = mit.id
JOIN organization_memberships om ON mi.workos_user_id = om.workos_user_id
WHERE mi.is_current = TRUE
  AND om.workos_organization_id IS NOT NULL
  AND mit.name IN ('building', 'company_focus', 'interest', 'aao_goals')
  AND NOT EXISTS (
    SELECT 1 FROM org_knowledge ok
    WHERE ok.workos_organization_id = om.workos_organization_id
      AND ok.attribute = mit.name
      AND ok.is_current = TRUE
  )
ORDER BY om.workos_organization_id, mit.name, mi.created_at DESC;

-- =====================================================
-- INITIAL JOURNEY STAGE COMPUTATION
-- =====================================================
-- Set journey_stage on organizations based on current data.
-- This is a one-time computation; future changes will be event-driven.

-- Organizations with leadership roles -> 'leading'
-- (Uses working_group_leaders table, not the dropped chair_user_id columns)
UPDATE organizations o SET
  journey_stage = 'leading',
  journey_stage_set_at = NOW()
WHERE EXISTS (
  SELECT 1 FROM working_group_leaders wgl
  JOIN organization_memberships om ON om.workos_user_id = wgl.user_id
  WHERE om.workos_organization_id = o.workos_organization_id
)
AND o.journey_stage IS NULL;

-- Organizations with working group memberships -> 'participating'
UPDATE organizations o SET
  journey_stage = 'participating',
  journey_stage_set_at = NOW()
WHERE EXISTS (
  SELECT 1 FROM working_group_memberships wgm
  JOIN organization_memberships om ON wgm.workos_user_id = om.workos_user_id
  WHERE om.workos_organization_id = o.workos_organization_id
    AND wgm.status = 'active'
)
AND o.journey_stage IS NULL;

-- Organizations created > 90 days ago without group memberships -> 'joined'
UPDATE organizations SET
  journey_stage = 'joined',
  journey_stage_set_at = NOW()
WHERE created_at < NOW() - INTERVAL '90 days'
  AND journey_stage IS NULL
  AND subscription_status IS NOT NULL;

-- Organizations created < 90 days ago -> 'onboarding'
UPDATE organizations SET
  journey_stage = 'onboarding',
  journey_stage_set_at = NOW()
WHERE created_at >= NOW() - INTERVAL '90 days'
  AND journey_stage IS NULL
  AND subscription_status IS NOT NULL;

-- Log initial journey stages
INSERT INTO journey_stage_history (workos_organization_id, from_stage, to_stage, trigger_type, trigger_detail, triggered_by)
SELECT
  workos_organization_id,
  NULL,
  journey_stage,
  'initial',
  'backfill from migration 207',
  'system'
FROM organizations
WHERE journey_stage IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM journey_stage_history jsh
    WHERE jsh.workos_organization_id = organizations.workos_organization_id
  );
