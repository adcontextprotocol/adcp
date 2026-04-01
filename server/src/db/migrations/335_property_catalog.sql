-- Migration: 332_property_catalog.sql
-- Purpose: Fact-graph-based property catalog replacing the two-table registry.
-- The catalog accumulates evidence from multiple pipelines and materializes
-- a property graph with stable UUIDs (property_rid) for TMP matching.

-- =============================================================================
-- 1. catalog_properties — one row per addressable property
-- =============================================================================

CREATE TABLE catalog_properties (
  property_rid UUID PRIMARY KEY,          -- UUID v7, generated in application
  property_id TEXT,                       -- publisher slug from adagents.json (null for contributed)
  classification TEXT NOT NULL DEFAULT 'unclassified'
    CHECK (classification IN ('property', 'ad_infra', 'publisher_mask', 'network', 'unclassified')),
  source TEXT NOT NULL CHECK (source IN ('authoritative', 'enriched', 'contributed')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'removed')),
  adagents_url TEXT,                      -- where the authoritative adagents.json lives (null = registry-managed)
  created_by TEXT,                        -- member_id or 'system'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_catalog_properties_updated ON catalog_properties(updated_at);
CREATE INDEX idx_catalog_properties_classification
  ON catalog_properties(classification) WHERE classification = 'property';
CREATE INDEX idx_catalog_properties_status
  ON catalog_properties(status) WHERE status = 'active';

-- =============================================================================
-- 2. catalog_identifiers — many-to-one identifier→property mapping
-- =============================================================================

CREATE TABLE catalog_identifiers (
  id UUID PRIMARY KEY,                     -- UUID v7
  property_rid UUID NOT NULL REFERENCES catalog_properties(property_rid),
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  evidence TEXT NOT NULL,                  -- adagents_json, app_store, member_resolve, addie_analysis, data_partner, ads_txt, dns
  confidence TEXT NOT NULL                 -- authoritative, strong, medium, weak
    CHECK (confidence IN ('authoritative', 'strong', 'medium', 'weak')),
  disputed BOOLEAN NOT NULL DEFAULT FALSE, -- suspended pending dispute resolution
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(identifier_type, identifier_value),
  CONSTRAINT chk_identifier_lowercase CHECK (identifier_value = lower(identifier_value))
);

CREATE INDEX idx_catalog_identifiers_property ON catalog_identifiers(property_rid);
CREATE INDEX idx_catalog_identifiers_type ON catalog_identifiers(identifier_type);

-- =============================================================================
-- 3. catalog_facts — append-only fact log from all pipelines
-- =============================================================================

CREATE TABLE catalog_facts (
  fact_id UUID PRIMARY KEY,                -- UUID v7
  fact_type TEXT NOT NULL,                 -- identity, linking, classification, ownership, edit_history
  subject_type TEXT NOT NULL,              -- identifier, property_rid
  subject_value TEXT NOT NULL,
  predicate TEXT NOT NULL,                 -- exists, same_property_as, classified_as, owned_by, has_identifier, etc.
  object_value TEXT,
  source TEXT NOT NULL,                    -- adagents_json, app_store, ads_txt, web_crawl, member_resolve, addie_analysis, data_partner, system
  confidence TEXT NOT NULL
    CHECK (confidence IN ('authoritative', 'strong', 'medium', 'weak')),
  actor TEXT NOT NULL,                     -- pipeline name, member_id, 'system'
  provenance_type TEXT,                    -- for member_resolve: agency_allowlist, impression_log, ssp_inventory, deal_history, data_partner
  provenance_context TEXT,
  superseded_by UUID,                      -- if this fact has been replaced by a stronger one
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX idx_catalog_facts_subject ON catalog_facts(subject_type, subject_value);
CREATE INDEX idx_catalog_facts_source ON catalog_facts(source, created_at);
CREATE INDEX idx_catalog_facts_type ON catalog_facts(fact_type, created_at);

-- =============================================================================
-- 4. catalog_aliases — merged property redirects
-- =============================================================================

CREATE TABLE catalog_aliases (
  alias_rid UUID PRIMARY KEY,
  canonical_rid UUID NOT NULL REFERENCES catalog_properties(property_rid),
  merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence TEXT NOT NULL,
  actor TEXT NOT NULL
);

CREATE INDEX idx_catalog_aliases_canonical ON catalog_aliases(canonical_rid);

-- =============================================================================
-- 5. catalog_activity — resolve call log, partitioned by month
-- =============================================================================

CREATE TABLE catalog_activity (
  id UUID NOT NULL,                        -- UUID v7
  property_rid UUID NOT NULL,
  member_id TEXT NOT NULL,
  provenance_type TEXT NOT NULL,
  provenance_context TEXT,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (resolved_at);

CREATE INDEX idx_catalog_activity_property_member
  ON catalog_activity(property_rid, member_id, provenance_type) INCLUDE (resolved_at);
CREATE INDEX idx_catalog_activity_member ON catalog_activity(member_id);
CREATE INDEX idx_catalog_activity_time_property ON catalog_activity(resolved_at, property_rid);

-- Create partitions for current quarter + next quarter
CREATE TABLE catalog_activity_2026_01 PARTITION OF catalog_activity
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE catalog_activity_2026_02 PARTITION OF catalog_activity
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE catalog_activity_2026_03 PARTITION OF catalog_activity
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE catalog_activity_2026_04 PARTITION OF catalog_activity
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE catalog_activity_2026_05 PARTITION OF catalog_activity
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE catalog_activity_2026_06 PARTITION OF catalog_activity
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE catalog_activity_2026_07 PARTITION OF catalog_activity
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE catalog_activity_2026_08 PARTITION OF catalog_activity
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE catalog_activity_2026_09 PARTITION OF catalog_activity
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE catalog_activity_2026_10 PARTITION OF catalog_activity
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE catalog_activity_2026_11 PARTITION OF catalog_activity
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE catalog_activity_2026_12 PARTITION OF catalog_activity
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- =============================================================================
-- 6. catalog_disputes — dispute tracking with triage and resolution
-- =============================================================================

CREATE TABLE catalog_disputes (
  id UUID PRIMARY KEY,                     -- UUID v7
  dispute_type TEXT NOT NULL               -- what's being disputed
    CHECK (dispute_type IN ('identifier_link', 'classification', 'property_data', 'false_merge')),
  subject_type TEXT NOT NULL,              -- 'identifier', 'property_rid', 'link'
  subject_value TEXT NOT NULL,
  reported_by TEXT NOT NULL,               -- member_id
  reported_by_email TEXT,
  claim TEXT NOT NULL,                     -- what the reporter asserts is wrong
  evidence TEXT,                           -- supporting evidence from the reporter
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'investigating', 'resolved', 'rejected', 'escalated')),
  resolution TEXT,
  resolved_by TEXT,                        -- 'system:addie', member_id, or admin email
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_catalog_disputes_status ON catalog_disputes(status) WHERE status IN ('open', 'investigating', 'escalated');
CREATE INDEX idx_catalog_disputes_subject ON catalog_disputes(subject_type, subject_value);
CREATE INDEX idx_catalog_disputes_reporter ON catalog_disputes(reported_by);

-- =============================================================================
-- 7. Materialized view for analytics
-- =============================================================================

CREATE MATERIALIZED VIEW catalog_activity_daily AS
SELECT
  property_rid,
  member_id,
  provenance_type,
  date_trunc('day', resolved_at) AS resolve_date,
  count(*) AS resolve_count
FROM catalog_activity
GROUP BY 1, 2, 3, 4;

CREATE UNIQUE INDEX idx_catalog_activity_daily_pk
  ON catalog_activity_daily(property_rid, member_id, provenance_type, resolve_date);
CREATE INDEX idx_catalog_activity_daily_property
  ON catalog_activity_daily(property_rid);
