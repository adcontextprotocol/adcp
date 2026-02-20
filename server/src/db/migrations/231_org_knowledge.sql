-- Migration: 205_org_knowledge.sql
-- Unified knowledge provenance for organization attributes.
--
-- The same fact about an org (e.g., what they build, their company type) can come
-- from multiple sources: user-reported, admin-set, enrichment services, Addie inference,
-- or a diagnostic tool. This table tracks each assertion with its source, confidence,
-- and timestamp, enabling precedence-based resolution when sources conflict.
--
-- This supplements (not replaces) existing org columns. Existing columns remain for
-- fast reads; org_knowledge is the authoritative record of WHERE data came from.

-- =====================================================
-- ORG KNOWLEDGE TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS org_knowledge (
  id SERIAL PRIMARY KEY,

  -- Which organization this knowledge is about
  workos_organization_id VARCHAR(255) NOT NULL
    REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,

  -- What attribute this describes
  attribute VARCHAR(100) NOT NULL,           -- e.g., 'company_type', 'revenue_tier', 'persona', 'building'

  -- The asserted value
  value TEXT NOT NULL,                       -- Text representation of the value
  value_json JSONB,                          -- Structured value when applicable (arrays, objects)

  -- Provenance
  source VARCHAR(50) NOT NULL
    CHECK (source IN ('user_reported', 'admin_set', 'diagnostic', 'enrichment', 'addie_inferred')),
  confidence VARCHAR(20) NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('high', 'medium', 'low')),

  -- Who provided it
  set_by_user_id VARCHAR(255),              -- WorkOS user ID (for user_reported and admin_set)
  set_by_description VARCHAR(255),          -- Human-readable label (e.g., 'Lusha API', 'Addie via Slack conversation')

  -- Timestamps
  set_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMP WITH TIME ZONE,     -- When this was last confirmed to still be true

  -- Version tracking
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  superseded_by INTEGER REFERENCES org_knowledge(id),
  superseded_at TIMESTAMP WITH TIME ZONE,

  -- Source reference (for traceability)
  source_reference TEXT,                    -- Thread ID, enrichment request ID, diagnostic session ID, etc.

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- INDEXES
-- =====================================================

-- Primary lookup: current knowledge for an org
CREATE INDEX IF NOT EXISTS idx_org_knowledge_current
  ON org_knowledge(workos_organization_id, attribute)
  WHERE is_current = TRUE;

-- Find all knowledge about an org (including history)
CREATE INDEX IF NOT EXISTS idx_org_knowledge_org
  ON org_knowledge(workos_organization_id);

-- Find all orgs with a specific attribute value (e.g., all orgs with persona='molecule_builder')
CREATE INDEX IF NOT EXISTS idx_org_knowledge_attribute_value
  ON org_knowledge(attribute, value)
  WHERE is_current = TRUE;

-- Find knowledge by source (e.g., all enrichment-sourced data for staleness checks)
CREATE INDEX IF NOT EXISTS idx_org_knowledge_source
  ON org_knowledge(source, set_at)
  WHERE is_current = TRUE;

-- Staleness check: find knowledge that hasn't been verified recently
CREATE INDEX IF NOT EXISTS idx_org_knowledge_stale
  ON org_knowledge(verified_at NULLS FIRST)
  WHERE is_current = TRUE;

-- =====================================================
-- ATTRIBUTE REGISTRY
-- =====================================================
-- Defines known attributes, their valid values, and which sources are allowed.
-- Optional: queries work without this, but it helps with validation and documentation.

CREATE TABLE IF NOT EXISTS org_knowledge_attributes (
  name VARCHAR(100) PRIMARY KEY,
  description TEXT,
  value_type VARCHAR(20) NOT NULL DEFAULT 'text'
    CHECK (value_type IN ('text', 'enum', 'number', 'boolean', 'json')),
  valid_values TEXT[],                      -- For enum types: list of allowed values
  allowed_sources TEXT[],                   -- Which sources can set this (NULL = all)
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- SEED ATTRIBUTE DEFINITIONS
-- =====================================================

INSERT INTO org_knowledge_attributes (name, description, value_type, valid_values) VALUES
  ('company_type', 'Primary business type', 'enum', ARRAY['adtech', 'agency', 'brand', 'publisher', 'data', 'ai', 'other']),
  ('revenue_tier', 'Annual revenue tier', 'enum', ARRAY['under_1m', '1m_5m', '5m_50m', '50m_250m', '250m_1b', '1b_plus']),
  ('revenue', 'Estimated annual revenue in USD', 'number', NULL),
  ('industry', 'Primary industry vertical', 'text', NULL),
  ('employee_count', 'Estimated employee count', 'number', NULL),
  ('description', 'Organization description', 'text', NULL),
  ('building', 'What the org is building or working on', 'text', NULL),
  ('company_focus', 'What the org does in ad tech', 'text', NULL),
  ('interest', 'Topics or areas the org is interested in', 'text', NULL),
  ('aao_goals', 'What the org wants from AgenticAdvertising.org', 'text', NULL),
  ('focus_area', 'Primary focus area in ad tech', 'text', NULL),
  ('interest_level', 'AAO staff assessment of org interest', 'enum', ARRAY['low', 'medium', 'high', 'very_high']),
  ('persona', 'Behavioral persona classification', 'enum', ARRAY['molecule_builder', 'data_decoder', 'pureblood_protector', 'resops_integrator', 'ladder_climber', 'simple_starter']),
  ('aspiration_persona', 'Where the org aspires to be', 'enum', ARRAY['molecule_builder', 'data_decoder', 'pureblood_protector', 'resops_integrator', 'ladder_climber', 'simple_starter']),
  ('journey_stage', 'Current stage in member journey', 'enum', ARRAY['aware', 'evaluating', 'joined', 'onboarding', 'participating', 'contributing', 'leading', 'advocating'])
ON CONFLICT (name) DO NOTHING;

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE org_knowledge IS 'Unified provenance tracking for organization attributes. Each row is one source asserting a value for an attribute.';
COMMENT ON COLUMN org_knowledge.attribute IS 'The attribute name (e.g., company_type, persona). See org_knowledge_attributes for registry.';
COMMENT ON COLUMN org_knowledge.source IS 'Who/what provided this value. user_reported > admin_set > diagnostic > enrichment > addie_inferred';
COMMENT ON COLUMN org_knowledge.confidence IS 'How reliable this assertion is. Used within a source tier for ranking.';
COMMENT ON COLUMN org_knowledge.verified_at IS 'When this value was last confirmed. NULL means never verified since initial set. Used for staleness checks.';
COMMENT ON COLUMN org_knowledge.is_current IS 'TRUE if this is the active assertion for this org+attribute+source combo. Historical entries have FALSE.';
COMMENT ON COLUMN org_knowledge.superseded_by IS 'Points to the newer entry that replaced this one (within same source).';

COMMENT ON TABLE org_knowledge_attributes IS 'Registry of known org_knowledge attributes with validation rules. Optional but useful for consistency.';
