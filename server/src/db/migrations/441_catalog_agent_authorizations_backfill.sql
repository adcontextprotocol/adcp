-- Backfill catalog_agent_authorizations from the two legacy tables.
-- Runs after migration 440 creates the empty schema.
--
-- Legacy → catalog mapping:
--   agent_property_authorizations           → per-property rows
--   agent_publisher_authorizations          → mixed: property_ids[] fans out
--                                              into per-property rows; NULL
--                                              property_ids → publisher-wide
--   source='adagents_json' → evidence='adagents_json'
--   source='agent_claim'   → evidence='agent_claim', created_by=<agent_url>
--   source='community'     → evidence='community'
--   any other source value → migration aborts (see assertion below)
--
-- Property-rid resolution: legacy agent_property_authorizations.property_id
-- references discovered_properties.id, which migration 336 seeded as
-- catalog_properties.property_rid. Post-seed properties have diverging
-- UUIDs — those rows skip the backfill and continue to be served from
-- legacy until PR 5 drops the legacy tables. The PR 4a-style UNION
-- reader covers them in the meantime. We RAISE NOTICE the orphan count
-- so the migration log shows whether the legacy table had any
-- post-seed authorization rows that didn't carry over.
--
-- Canonicalization: legacy URLs were stored with mixed case and
-- inconsistent trailing slashes. Backfill lowercases + strips trailing
-- slash. Wildcard '*' passes through (the schema CHECK explicitly
-- accepts it).

-- =============================================================================
-- 0. Pre-flight: assert legacy source values are known
-- =============================================================================
-- The legacy agent_publisher_authorizations.source column is
-- unconstrained TEXT (migration 025). Production should only contain
-- 'adagents_json' and 'agent_claim' (those are the only values
-- federated-index.ts ever writes), but a defensive assertion fails
-- loudly rather than silently re-classifying unknowns. Without this,
-- a row with source='community' or anything else would be dropped on
-- the floor or silently widened to the highest-trust evidence value.

DO $$
DECLARE
  unknown_count INTEGER;
  unknown_sample TEXT;
BEGIN
  SELECT COUNT(*),
         string_agg(DISTINCT source, ', ' ORDER BY source)
    INTO unknown_count, unknown_sample
    FROM agent_publisher_authorizations
   WHERE source NOT IN ('adagents_json', 'agent_claim', 'community');
  IF unknown_count > 0 THEN
    RAISE EXCEPTION
      'Backfill blocked: % rows in agent_publisher_authorizations carry unrecognized source values (%). Investigate, then either add the values to the recognized set or repair the legacy data before re-running this migration.',
      unknown_count, unknown_sample;
  END IF;
END $$;

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
  apa.source                                          AS evidence,  -- pre-flight assertion above guarantees this is in the enum
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

-- =============================================================================
-- 4. Observability: report orphan counts
-- =============================================================================
-- Surface in the migration log how many legacy rows didn't carry over so an
-- operator can verify the count is plausible. Orphans are expected — they're
-- post-seed agent_property_authorizations rows whose property_rid doesn't
-- match a catalog_properties row (because the writer-side IDs diverged after
-- migration 336's one-time seed). The PR 4a-style UNION reader covers them
-- until PR 5 drops the legacy tables.

DO $$
DECLARE
  orphan_per_prop INTEGER;
  orphan_publisher INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_per_prop
  FROM agent_property_authorizations apa
  LEFT JOIN catalog_properties cp ON cp.property_rid = apa.property_id
  WHERE cp.property_rid IS NULL;
  RAISE NOTICE 'Backfill: % per-property auth rows skipped (no matching catalog_properties row; legacy table still serves them)', orphan_per_prop;

  SELECT COUNT(*) INTO orphan_publisher
  FROM agent_publisher_authorizations apa
  CROSS JOIN LATERAL unnest(COALESCE(apa.property_ids, ARRAY[]::text[])) AS slug
  LEFT JOIN catalog_properties cp
    ON cp.property_id = slug
   AND cp.created_by   = 'adagents_json:' || apa.publisher_domain
  WHERE apa.property_ids IS NOT NULL
    AND array_length(apa.property_ids, 1) IS NOT NULL
    AND cp.property_rid IS NULL;
  RAISE NOTICE 'Backfill: % publisher-scoped auth slugs skipped (slug did not resolve to a catalog_properties row)', orphan_publisher;
END $$;
