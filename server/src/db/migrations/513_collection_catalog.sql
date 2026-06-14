-- Migration: 513_collection_catalog.sql
-- Purpose: Fact-graph-based collection catalog mirroring the property catalog.
-- Collections are publisher-authored content programs (shows, channels,
-- publications, event series) with distribution identifiers for cross-platform
-- lookup, e.g. stuk.tv/stuktv -> youtube.com/youtube_channel_id/uck...

-- =============================================================================
-- 1. catalog_collections — one row per publisher-authored collection
-- =============================================================================

CREATE TABLE catalog_collections (
  collection_rid UUID PRIMARY KEY,         -- UUID v7, generated in application
  publisher_domain TEXT NOT NULL,          -- domain whose adagents.json declares collection_id
  collection_id TEXT,                      -- publisher-local slug from adagents.json
  name TEXT,
  kind TEXT,
  source TEXT NOT NULL CHECK (source IN ('authoritative', 'enriched', 'contributed')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'removed')),
  adagents_url TEXT,                       -- authoritative adagents.json, null for registry-managed
  collection_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,                         -- member_id, system, or adagents_json:<domain>
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_catalog_collections_publisher_domain_lowercase
    CHECK (publisher_domain = lower(publisher_domain)),
  CONSTRAINT uq_catalog_collections_publisher_collection
    UNIQUE (publisher_domain, collection_id)
);

CREATE INDEX idx_catalog_collections_updated ON catalog_collections(updated_at);
CREATE INDEX idx_catalog_collections_publisher ON catalog_collections(publisher_domain);
CREATE INDEX idx_catalog_collections_kind ON catalog_collections(kind) WHERE kind IS NOT NULL;
CREATE INDEX idx_catalog_collections_status
  ON catalog_collections(status) WHERE status = 'active';

-- =============================================================================
-- 2. catalog_collection_identifiers — distribution identifier → collection
-- =============================================================================

CREATE TABLE catalog_collection_identifiers (
  id UUID PRIMARY KEY,                      -- UUID v7
  collection_rid UUID NOT NULL REFERENCES catalog_collections(collection_rid),
  distribution_publisher_domain TEXT NOT NULL,
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  evidence TEXT NOT NULL,                   -- adagents_json, feed_import, member_resolve, manual_review, data_partner
  confidence TEXT NOT NULL
    CHECK (confidence IN ('authoritative', 'strong', 'medium', 'weak')),
  disputed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(distribution_publisher_domain, identifier_type, identifier_value),
  CONSTRAINT chk_collection_identifiers_distribution_domain_lowercase
    CHECK (distribution_publisher_domain = lower(distribution_publisher_domain))
);

CREATE INDEX idx_catalog_collection_identifiers_collection
  ON catalog_collection_identifiers(collection_rid);
CREATE INDEX idx_catalog_collection_identifiers_type
  ON catalog_collection_identifiers(identifier_type);
CREATE INDEX idx_catalog_collection_identifiers_distribution
  ON catalog_collection_identifiers(distribution_publisher_domain);

-- =============================================================================
-- 3. catalog_collection_facts — append-only collection fact log
-- =============================================================================

CREATE TABLE catalog_collection_facts (
  fact_id UUID PRIMARY KEY,                 -- UUID v7
  fact_type TEXT NOT NULL,                  -- identity, linking, metadata, ownership, edit_history
  subject_type TEXT NOT NULL,               -- identifier, collection_rid, publisher_collection
  subject_value TEXT NOT NULL,
  predicate TEXT NOT NULL,                  -- exists, has_identifier, distributed_on, owned_by, merged_into
  object_value TEXT,
  source TEXT NOT NULL,                     -- adagents_json, feed_import, web_crawl, member_resolve, data_partner, system
  confidence TEXT NOT NULL
    CHECK (confidence IN ('authoritative', 'strong', 'medium', 'weak')),
  actor TEXT NOT NULL,
  provenance_type TEXT,
  provenance_context TEXT,
  superseded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX idx_catalog_collection_facts_subject
  ON catalog_collection_facts(subject_type, subject_value);
CREATE INDEX idx_catalog_collection_facts_source
  ON catalog_collection_facts(source, created_at);
CREATE INDEX idx_catalog_collection_facts_type
  ON catalog_collection_facts(fact_type, created_at);

-- =============================================================================
-- 4. catalog_collection_aliases — merged collection redirects
-- =============================================================================

CREATE TABLE catalog_collection_aliases (
  alias_rid UUID PRIMARY KEY,
  canonical_rid UUID NOT NULL REFERENCES catalog_collections(collection_rid),
  merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence TEXT NOT NULL,
  actor TEXT NOT NULL
);

CREATE INDEX idx_catalog_collection_aliases_canonical
  ON catalog_collection_aliases(canonical_rid);

-- =============================================================================
-- 5. catalog_collection_activity — resolve call log, partitioned by month
-- =============================================================================

CREATE TABLE catalog_collection_activity (
  id UUID NOT NULL,                         -- UUID v7
  collection_rid UUID NOT NULL,
  member_id TEXT NOT NULL,
  provenance_type TEXT NOT NULL,
  provenance_context TEXT,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (resolved_at);

CREATE INDEX idx_catalog_collection_activity_collection_member
  ON catalog_collection_activity(collection_rid, member_id, provenance_type) INCLUDE (resolved_at);
CREATE INDEX idx_catalog_collection_activity_member ON catalog_collection_activity(member_id);
CREATE INDEX idx_catalog_collection_activity_time_collection
  ON catalog_collection_activity(resolved_at, collection_rid);

CREATE TABLE catalog_collection_activity_2026_01 PARTITION OF catalog_collection_activity
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE catalog_collection_activity_2026_02 PARTITION OF catalog_collection_activity
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE catalog_collection_activity_2026_03 PARTITION OF catalog_collection_activity
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE catalog_collection_activity_2026_04 PARTITION OF catalog_collection_activity
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE catalog_collection_activity_2026_05 PARTITION OF catalog_collection_activity
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE catalog_collection_activity_2026_06 PARTITION OF catalog_collection_activity
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE catalog_collection_activity_2026_07 PARTITION OF catalog_collection_activity
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE catalog_collection_activity_2026_08 PARTITION OF catalog_collection_activity
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE catalog_collection_activity_2026_09 PARTITION OF catalog_collection_activity
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE catalog_collection_activity_2026_10 PARTITION OF catalog_collection_activity
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE catalog_collection_activity_2026_11 PARTITION OF catalog_collection_activity
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE catalog_collection_activity_2026_12 PARTITION OF catalog_collection_activity
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE catalog_collection_activity_default PARTITION OF catalog_collection_activity
  DEFAULT;

-- =============================================================================
-- 6. catalog_collection_disputes — collection dispute tracking
-- =============================================================================

CREATE TABLE catalog_collection_disputes (
  id UUID PRIMARY KEY,                      -- UUID v7
  dispute_type TEXT NOT NULL
    CHECK (dispute_type IN ('identifier_link', 'metadata', 'false_merge', 'ownership')),
  subject_type TEXT NOT NULL,               -- identifier, collection_rid, publisher_collection, link
  subject_value TEXT NOT NULL,
  reported_by TEXT NOT NULL,
  reported_by_email TEXT,
  claim TEXT NOT NULL,
  evidence TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'investigating', 'resolved', 'rejected', 'escalated')),
  resolution TEXT,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_catalog_collection_disputes_status
  ON catalog_collection_disputes(status) WHERE status IN ('open', 'investigating', 'escalated');
CREATE INDEX idx_catalog_collection_disputes_subject
  ON catalog_collection_disputes(subject_type, subject_value);
CREATE INDEX idx_catalog_collection_disputes_reporter
  ON catalog_collection_disputes(reported_by);

-- =============================================================================
-- 7. Materialized view for analytics
-- =============================================================================

CREATE MATERIALIZED VIEW catalog_collection_activity_daily AS
SELECT
  collection_rid,
  member_id,
  provenance_type,
  date_trunc('day', resolved_at) AS resolve_date,
  count(*) AS resolve_count
FROM catalog_collection_activity
GROUP BY 1, 2, 3, 4;

CREATE UNIQUE INDEX idx_catalog_collection_activity_daily_pk
  ON catalog_collection_activity_daily(collection_rid, member_id, provenance_type, resolve_date);
CREATE INDEX idx_catalog_collection_activity_daily_collection
  ON catalog_collection_activity_daily(collection_rid);
