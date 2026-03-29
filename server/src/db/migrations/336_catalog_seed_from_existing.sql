-- Migration: 333_catalog_seed_from_existing.sql
-- Purpose: Migrate existing property data into the catalog tables.
-- Runs after 332_property_catalog.sql creates the schema.
--
-- Sources:
--   discovered_properties → catalog_properties (authoritative) + catalog_identifiers
--   hosted_properties (approved) → catalog_properties (contributed/enriched) + catalog_identifiers
--   domain_classifications → catalog_facts (classification facts)

-- =============================================================================
-- 1. Migrate discovered_properties (authoritative, from adagents.json)
-- =============================================================================

-- Each unique publisher_domain gets a catalog_properties row.
-- We use the discovered_properties.id as the property_rid to maintain traceability.
INSERT INTO catalog_properties (
  property_rid,
  property_id,
  classification,
  source,
  status,
  adagents_url,
  created_by,
  created_at,
  updated_at,
  source_updated_at
)
SELECT DISTINCT ON (dp.publisher_domain, COALESCE(dp.property_id, dp.name))
  dp.id AS property_rid,
  dp.property_id,
  'property' AS classification,
  'authoritative' AS source,
  'active' AS status,
  'https://' || dp.publisher_domain || '/.well-known/adagents.json' AS adagents_url,
  'system' AS created_by,
  dp.discovered_at AS created_at,
  COALESCE(dp.last_validated, dp.discovered_at) AS updated_at,
  COALESCE(dp.last_validated, dp.discovered_at) AS source_updated_at
FROM discovered_properties dp
ORDER BY dp.publisher_domain, COALESCE(dp.property_id, dp.name), dp.discovered_at ASC;

-- Create catalog_identifiers from the identifiers JSONB array on each discovered_property.
-- Each {type, value} object in the array becomes a row.
INSERT INTO catalog_identifiers (id, property_rid, identifier_type, identifier_value, evidence, confidence, created_at)
SELECT
  gen_random_uuid() AS id,
  dp.id AS property_rid,
  ident->>'type' AS identifier_type,
  lower(ident->>'value') AS identifier_value,
  'adagents_json' AS evidence,
  'authoritative' AS confidence,
  dp.discovered_at AS created_at
FROM discovered_properties dp,
  jsonb_array_elements(dp.identifiers) AS ident
WHERE ident->>'type' IS NOT NULL
  AND ident->>'value' IS NOT NULL
  AND dp.id IN (SELECT property_rid FROM catalog_properties)
ON CONFLICT (identifier_type, identifier_value) DO NOTHING;

-- For discovered properties that have no identifiers array entries,
-- create a domain identifier from the publisher_domain.
INSERT INTO catalog_identifiers (id, property_rid, identifier_type, identifier_value, evidence, confidence, created_at)
SELECT
  gen_random_uuid() AS id,
  dp.id AS property_rid,
  'domain' AS identifier_type,
  lower(dp.publisher_domain) AS identifier_value,
  'adagents_json' AS evidence,
  'authoritative' AS confidence,
  dp.discovered_at AS created_at
FROM discovered_properties dp
WHERE dp.id IN (SELECT property_rid FROM catalog_properties)
  AND NOT EXISTS (
    SELECT 1 FROM catalog_identifiers ci
    WHERE ci.property_rid = dp.id
  )
ON CONFLICT (identifier_type, identifier_value) DO NOTHING;

-- =============================================================================
-- 2. Migrate hosted_properties (contributed/enriched, community-managed)
-- =============================================================================

-- Only approved, public properties. Skip domains that already have authoritative entries.
INSERT INTO catalog_properties (
  property_rid,
  property_id,
  classification,
  source,
  status,
  adagents_url,
  created_by,
  created_at,
  updated_at,
  source_updated_at
)
SELECT
  hp.id AS property_rid,
  NULL AS property_id,
  'property' AS classification,
  CASE WHEN hp.source_type = 'enriched' THEN 'enriched' ELSE 'contributed' END AS source,
  'active' AS status,
  NULL AS adagents_url,
  COALESCE(hp.created_by_email, 'system') AS created_by,
  hp.created_at,
  hp.updated_at,
  hp.updated_at AS source_updated_at
FROM hosted_properties hp
WHERE hp.review_status = 'approved'
  AND hp.is_public = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM catalog_identifiers ci
    WHERE ci.identifier_type = 'domain'
      AND ci.identifier_value = lower(hp.publisher_domain)
  )
ON CONFLICT (property_rid) DO NOTHING;

-- Create domain identifiers for hosted properties
INSERT INTO catalog_identifiers (id, property_rid, identifier_type, identifier_value, evidence, confidence, created_at)
SELECT
  gen_random_uuid() AS id,
  hp.id AS property_rid,
  'domain' AS identifier_type,
  lower(hp.publisher_domain) AS identifier_value,
  'member_resolve' AS evidence,
  'medium' AS confidence,
  hp.created_at
FROM hosted_properties hp
WHERE hp.id IN (SELECT property_rid FROM catalog_properties)
ON CONFLICT (identifier_type, identifier_value) DO NOTHING;

-- =============================================================================
-- 3. Migrate domain_classifications as catalog_facts
-- =============================================================================

-- These are classification facts — they tell us which domains are ad infrastructure,
-- intermediaries, CDNs, or trackers. All map to ad_infra classification in the catalog.
INSERT INTO catalog_facts (
  fact_id,
  fact_type,
  subject_type,
  subject_value,
  predicate,
  object_value,
  source,
  confidence,
  actor,
  created_at
)
SELECT
  gen_random_uuid() AS fact_id,
  'classification' AS fact_type,
  'identifier' AS subject_type,
  lower(dc.domain) AS subject_value,
  'classified_as' AS predicate,
  'ad_infra' AS object_value,
  'system' AS source,
  'strong' AS confidence,
  'system:seed' AS actor,
  dc.created_at
FROM domain_classifications dc;

-- =============================================================================
-- 4. Migrate registry_requests as catalog_activity (demand signals)
-- =============================================================================

-- Best-effort: we don't have per-request granularity, so we create one activity
-- row per request record using the last_requested_at timestamp.
-- These go into the partitioned table, so they must fall in a valid partition range.
INSERT INTO catalog_activity (id, property_rid, member_id, provenance_type, provenance_context, resolved_at)
SELECT
  gen_random_uuid() AS id,
  cp.property_rid,
  'system:demand_signal' AS member_id,
  'data_partner' AS provenance_type,
  'migrated from registry_requests (count: ' || rr.request_count || ')' AS provenance_context,
  GREATEST(rr.last_requested_at, '2026-01-01'::timestamptz) AS resolved_at
FROM registry_requests rr
JOIN catalog_identifiers ci ON ci.identifier_type = 'domain' AND ci.identifier_value = lower(rr.domain)
JOIN catalog_properties cp ON cp.property_rid = ci.property_rid
WHERE rr.entity_type = 'property'
  AND rr.last_requested_at >= '2026-01-01'
  AND rr.last_requested_at < '2026-07-01';
