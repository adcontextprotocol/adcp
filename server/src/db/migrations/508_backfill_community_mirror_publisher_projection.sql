-- Backfill existing community_mirrors into the unified publisher registry
-- read model. Future PUT /api/registry/mirrors/:platform calls do this in
-- application code; this migration projects already-approved rows so
-- /api/registry/publisher/<domain> works immediately after deploy.

BEGIN;

DELETE FROM catalog_identifiers ci
 WHERE ci.property_rid IN (
   SELECT cp.property_rid
     FROM catalog_properties cp
    WHERE cp.created_by LIKE 'community_adagents:%'
 );

DELETE FROM catalog_properties
 WHERE created_by LIKE 'community_adagents:%';

DELETE FROM discovered_properties dp
 WHERE dp.source_type = 'community'
   AND EXISTS (
     SELECT 1
       FROM publishers p
      WHERE p.source_type = 'community'
        AND p.discovery_method = 'community_catalog'
        AND p.created_by_user_id LIKE 'community_adagents:%'
        AND p.domain = dp.publisher_domain
   );

DELETE FROM publishers
 WHERE source_type = 'community'
   AND discovery_method = 'community_catalog'
   AND created_by_user_id LIKE 'community_adagents:%';

CREATE TEMP TABLE tmp_community_mirror_properties ON COMMIT DROP AS
WITH raw_properties AS (
  SELECT
    cm.platform,
    cm.adagents_json,
    cm.created_by_email,
    prop,
    lower(trim(coalesce(
      nullif(prop->>'publisher_domain', ''),
      (
        SELECT ident->>'value'
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(prop->'identifiers') = 'array'
                 THEN prop->'identifiers'
                 ELSE '[]'::jsonb END
          ) AS ident
         WHERE ident->>'type' IN ('domain', 'subdomain')
           AND nullif(ident->>'value', '') IS NOT NULL
         LIMIT 1
      )
    ))) AS publisher_domain
  FROM community_mirrors cm
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(cm.adagents_json->'properties') = 'array'
         THEN cm.adagents_json->'properties'
         ELSE '[]'::jsonb END
  ) AS prop
)
SELECT
  gen_random_uuid() AS property_rid,
  platform,
  adagents_json,
  created_by_email,
  prop,
  publisher_domain
FROM raw_properties
WHERE publisher_domain IS NOT NULL
  AND publisher_domain <> '';

WITH grouped AS (
  SELECT
    platform,
    publisher_domain,
    jsonb_set(adagents_json, '{properties}', jsonb_agg(prop ORDER BY prop->>'property_id', prop->>'name')) AS scoped_manifest,
    min(created_by_email) AS created_by_email
  FROM tmp_community_mirror_properties
  GROUP BY platform, publisher_domain, adagents_json
)
INSERT INTO publishers
  (domain, adagents_json, source_type, review_status, is_public,
   last_validated, resolved_url, discovery_method,
   created_by_user_id, created_by_email)
SELECT
  publisher_domain,
  scoped_manifest,
  'community',
  'approved',
  TRUE,
  NULL,
  '/api/creative-agent/translated/' || platform || '/adagents.json',
  'community_catalog',
  'community_adagents:' || platform,
  created_by_email
FROM grouped
ON CONFLICT (domain) DO UPDATE SET
  adagents_json = CASE
    WHEN publishers.source_type = 'adagents_json' THEN publishers.adagents_json
    ELSE EXCLUDED.adagents_json
  END,
  source_type = CASE
    WHEN publishers.source_type = 'adagents_json' THEN publishers.source_type
    ELSE 'community'
  END,
  review_status = CASE
    WHEN publishers.source_type = 'adagents_json' THEN publishers.review_status
    ELSE 'approved'
  END,
  is_public = TRUE,
  last_validated = CASE
    WHEN publishers.source_type = 'adagents_json' THEN publishers.last_validated
    ELSE NULL
  END,
  resolved_url = CASE
    WHEN publishers.source_type = 'adagents_json' THEN publishers.resolved_url
    ELSE EXCLUDED.resolved_url
  END,
  discovery_method = CASE
    WHEN publishers.source_type = 'adagents_json' THEN publishers.discovery_method
    ELSE 'community_catalog'
  END,
  created_by_user_id = CASE
    WHEN publishers.source_type = 'adagents_json' THEN publishers.created_by_user_id
    ELSE EXCLUDED.created_by_user_id
  END,
  created_by_email = CASE
    WHEN publishers.source_type = 'adagents_json' THEN publishers.created_by_email
    ELSE EXCLUDED.created_by_email
  END,
  updated_at = NOW();

INSERT INTO discovered_properties
  (property_id, publisher_domain, property_type, name,
   identifiers, tags, source_type, last_validated)
SELECT
  prop->>'property_id',
  publisher_domain,
  coalesce(nullif(prop->>'property_type', ''), 'website'),
  coalesce(nullif(prop->>'name', ''), nullif(prop->>'property_id', ''), publisher_domain),
  CASE WHEN jsonb_typeof(prop->'identifiers') = 'array'
       THEN prop->'identifiers'
       ELSE '[]'::jsonb END,
  ARRAY(
    SELECT jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(prop->'tags') = 'array'
           THEN prop->'tags'
           ELSE '[]'::jsonb END
    )
  ),
  'community',
  NULL
FROM tmp_community_mirror_properties
ON CONFLICT (publisher_domain, name, property_type) DO UPDATE SET
  property_id = COALESCE(EXCLUDED.property_id, discovered_properties.property_id),
  identifiers = EXCLUDED.identifiers,
  tags = EXCLUDED.tags,
  source_type = CASE
    WHEN discovered_properties.source_type IN ('adagents_json', 'aao_hosted') THEN discovered_properties.source_type
    ELSE 'community'
  END,
  last_validated = discovered_properties.last_validated;

INSERT INTO catalog_properties
  (property_rid, property_id, classification, source, status, adagents_url, created_by)
SELECT
  property_rid,
  prop->>'property_id',
  'property',
  'contributed',
  'active',
  '/api/creative-agent/translated/' || platform || '/adagents.json',
  'community_adagents:' || platform
FROM tmp_community_mirror_properties
WHERE jsonb_array_length(
  CASE WHEN jsonb_typeof(prop->'identifiers') = 'array'
       THEN prop->'identifiers'
       ELSE '[]'::jsonb END
) > 0;

INSERT INTO catalog_identifiers
  (id, property_rid, identifier_type, identifier_value, evidence, confidence)
SELECT
  gen_random_uuid(),
  tmp.property_rid,
  lower(ident->>'type'),
  lower(ident->>'value'),
  'community',
  'strong'
FROM tmp_community_mirror_properties tmp
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(tmp.prop->'identifiers') = 'array'
       THEN tmp.prop->'identifiers'
       ELSE '[]'::jsonb END
) AS ident
WHERE nullif(ident->>'type', '') IS NOT NULL
  AND nullif(ident->>'value', '') IS NOT NULL
ON CONFLICT (identifier_type, identifier_value) DO NOTHING;

COMMIT;
