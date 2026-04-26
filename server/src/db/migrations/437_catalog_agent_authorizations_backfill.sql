-- Backfill catalog_agent_authorizations from the two legacy tables.
-- Runs after migration 436 creates the empty schema.
--
-- Legacy → catalog mapping:
--   agent_property_authorizations           → per-property rows
--   agent_publisher_authorizations          → mixed: property_ids[] fans out
--                                              into per-property rows; NULL
--                                              property_ids → publisher-wide
--   source='adagents_json' → evidence='adagents_json'
--   source='agent_claim'   → evidence='agent_claim', created_by=<agent_url>
--
-- Property-rid resolution: legacy agent_property_authorizations.property_id
-- references discovered_properties.id, which migration 336 seeded as
-- catalog_properties.property_rid. Post-seed properties have diverging
-- UUIDs — those rows skip the backfill and continue to be served from
-- legacy until PR 5 drops the legacy tables. The PR 4a-style UNION
-- reader covers them in the meantime.
--
-- Canonicalization: legacy URLs were stored with mixed case and
-- inconsistent trailing slashes. Backfill lowercases + strips trailing
-- slash. Wildcard '*' passes through (the schema CHECK explicitly
-- accepts it).

-- =============================================================================
-- 1. Per-property rows from agent_property_authorizations
-- =============================================================================
-- Resolve property_id (legacy UUID) → property_rid via catalog_properties.
-- For pre-seed rows, discovered_properties.id == catalog_properties.property_rid
-- by construction (migration 336). Post-seed rows where the IDs diverge
-- are skipped — the legacy table still serves them during dual-read.

INSERT INTO catalog_agent_authorizations (
  id, agent_url, agent_url_canonical, property_rid, property_id_slug,
  publisher_domain, authorized_for, evidence, created_by,
  created_at, updated_at
)
SELECT
  gen_random_uuid()                                   AS id,
  apa.agent_url                                       AS agent_url,
  CASE WHEN apa.agent_url = '*'
       THEN '*'
       ELSE rtrim(lower(apa.agent_url), '/')
  END                                                 AS agent_url_canonical,
  cp.property_rid                                     AS property_rid,
  dp.property_id                                      AS property_id_slug,
  NULL                                                AS publisher_domain,
  apa.authorized_for                                  AS authorized_for,
  'adagents_json'                                     AS evidence,
  'system'                                            AS created_by,
  apa.discovered_at                                   AS created_at,
  apa.discovered_at                                   AS updated_at
FROM agent_property_authorizations apa
JOIN discovered_properties dp ON dp.id = apa.property_id
JOIN catalog_properties    cp ON cp.property_rid = dp.id  -- pre-seed match
ON CONFLICT (agent_url_canonical,
             (COALESCE(property_rid::text, '')),
             (COALESCE(publisher_domain, '')),
             evidence)
WHERE deleted_at IS NULL
DO NOTHING;  -- idempotent re-run; uniqueness handled by partial index

-- =============================================================================
-- 2. Publisher-wide rows from agent_publisher_authorizations (NULL property_ids)
-- =============================================================================

INSERT INTO catalog_agent_authorizations (
  id, agent_url, agent_url_canonical, property_rid, property_id_slug,
  publisher_domain, authorized_for, evidence, created_by,
  created_at, updated_at
)
SELECT
  gen_random_uuid()                                   AS id,
  apa.agent_url                                       AS agent_url,
  CASE WHEN apa.agent_url = '*'
       THEN '*'
       ELSE rtrim(lower(apa.agent_url), '/')
  END                                                 AS agent_url_canonical,
  NULL                                                AS property_rid,
  NULL                                                AS property_id_slug,
  apa.publisher_domain                                AS publisher_domain,
  apa.authorized_for                                  AS authorized_for,
  CASE WHEN apa.source IN ('adagents_json', 'agent_claim')
       THEN apa.source
       ELSE 'adagents_json'  -- legacy rows with unexpected source values default to adagents_json
  END                                                 AS evidence,
  CASE WHEN apa.source = 'agent_claim'
       THEN apa.agent_url      -- claim assertor identifies as the claiming agent
       ELSE 'system'
  END                                                 AS created_by,
  apa.discovered_at                                   AS created_at,
  COALESCE(apa.last_validated, apa.discovered_at)     AS updated_at
FROM agent_publisher_authorizations apa
WHERE apa.property_ids IS NULL
   OR array_length(apa.property_ids, 1) IS NULL
ON CONFLICT (agent_url_canonical,
             (COALESCE(property_rid::text, '')),
             (COALESCE(publisher_domain, '')),
             evidence)
WHERE deleted_at IS NULL
DO NOTHING;

-- =============================================================================
-- 3. Per-property rows from agent_publisher_authorizations.property_ids[]
-- =============================================================================
-- The array carries the publisher's manifest slugs when authorization is
-- scoped to specific properties. Fan out via CROSS JOIN LATERAL unnest
-- and resolve each slug to a property_rid via catalog_properties.
-- created_by lookup: catalog_properties is keyed by ('adagents_json:' ||
-- publisher_domain). Slugs that don't resolve are skipped (legacy-only
-- data, served by UNION reader until PR 5).

INSERT INTO catalog_agent_authorizations (
  id, agent_url, agent_url_canonical, property_rid, property_id_slug,
  publisher_domain, authorized_for, evidence, created_by,
  created_at, updated_at
)
SELECT
  gen_random_uuid()                                   AS id,
  apa.agent_url                                       AS agent_url,
  CASE WHEN apa.agent_url = '*'
       THEN '*'
       ELSE rtrim(lower(apa.agent_url), '/')
  END                                                 AS agent_url_canonical,
  cp.property_rid                                     AS property_rid,
  slug                                                AS property_id_slug,
  NULL                                                AS publisher_domain,
  apa.authorized_for                                  AS authorized_for,
  CASE WHEN apa.source IN ('adagents_json', 'agent_claim')
       THEN apa.source
       ELSE 'adagents_json'
  END                                                 AS evidence,
  CASE WHEN apa.source = 'agent_claim'
       THEN apa.agent_url
       ELSE 'system'
  END                                                 AS created_by,
  apa.discovered_at                                   AS created_at,
  COALESCE(apa.last_validated, apa.discovered_at)     AS updated_at
FROM agent_publisher_authorizations apa
CROSS JOIN LATERAL unnest(apa.property_ids) AS slug
JOIN catalog_properties cp
  ON cp.property_id = slug
 AND cp.created_by   = 'adagents_json:' || apa.publisher_domain
WHERE apa.property_ids IS NOT NULL
  AND array_length(apa.property_ids, 1) IS NOT NULL
ON CONFLICT (agent_url_canonical,
             (COALESCE(property_rid::text, '')),
             (COALESCE(publisher_domain, '')),
             evidence)
WHERE deleted_at IS NULL
DO NOTHING;
