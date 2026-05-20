-- Catalog projection for publisher_properties fan-out rows (adcp#4841).
--
-- The fan-out write path (PR #4840) lands rows in the legacy
-- `agent_publisher_authorizations` table but the catalog projection in
-- `publisher-db.ts:upsertAdagentsCache` deliberately refuses cross-
-- publisher claims (line 968: "publisher_properties claims a different
-- publisher — cross-publisher refused"). Result: 6,800 cafemedia child
-- authorizations exist in the legacy arm but not in
-- `catalog_agent_authorizations`. The `/registry/authorizations` and
-- `/registry/authorizations/snapshot` partner-sync endpoints read the
-- catalog only and miss them.
--
-- This migration:
--   1. Widens the `evidence` CHECK to add `'adagents_authoritative'` —
--      a distinct evidence value for manager-asserted authorizations
--      (lower trust than `'adagents_json'`; the publisher itself was
--      not consulted, only the manager file is the source).
--   2. Backfills catalog rows from existing fan-out state — every
--      (agent_url, child_domain) pair where the child has
--      `discovery_method = 'adagents_authoritative'` gets a catalog row
--      with the new evidence value.
--
-- The writer change (publisher-db.ts:recordCatalogFanoutAuthorization,
-- called from crawler.ts fan-out helper) lands in the same PR and
-- writes new fan-out rows directly so the backfill is only needed once.
--
-- Trust profile of `'adagents_authoritative'` (documented in code +
-- spec PR #4827): manager-asserted, no bilateral confirmation. Lower
-- than `'adagents_json'`. Consumers SHOULD filter by evidence when
-- bilateral verification matters.

BEGIN;

-- 1. Widen the CHECK to include the new evidence value.
ALTER TABLE catalog_agent_authorizations
  DROP CONSTRAINT catalog_agent_authorizations_evidence_check;
ALTER TABLE catalog_agent_authorizations
  ADD CONSTRAINT catalog_agent_authorizations_evidence_check
  CHECK (evidence IN ('adagents_json', 'agent_claim', 'community', 'adagents_authoritative'));

COMMENT ON COLUMN catalog_agent_authorizations.evidence IS
  'Trust signal for the authorization edge. '
  '''adagents_json'': verified — publisher''s own adagents.json declares this. '
  '''agent_claim'': lower-trust — asserting agent claims authorization, publisher has not confirmed. '
  '''community'': curated by AAO moderators. '
  '''adagents_authoritative'': manager-asserted — a manager file (e.g., cafemedia.com) names this '
  'publisher in its publisher_properties[] selector, but the publisher itself was not directly '
  'fetched. Lower trust than ''adagents_json'' (no bilateral confirmation). Per #4825 inline '
  'resolution rule.';

-- 2. Backfill: insert catalog rows for every existing fan-out edge.
-- ON CONFLICT DO NOTHING preserves any existing rows (shouldn't be any
-- with this evidence value yet, but defensive).
INSERT INTO catalog_agent_authorizations
  (agent_url, agent_url_canonical, property_rid, property_id_slug,
   publisher_domain, authorized_for, evidence, created_by)
SELECT
  apa.agent_url,
  LOWER(RTRIM(BTRIM(apa.agent_url), '/')),
  NULL,
  NULL,
  pub.domain,
  apa.authorized_for,
  'adagents_authoritative',
  'system'
FROM publishers pub
JOIN agent_publisher_authorizations apa ON apa.publisher_domain = pub.domain
WHERE pub.discovery_method = 'adagents_authoritative'
  AND apa.source = 'adagents_json'
ON CONFLICT (agent_url_canonical,
             (COALESCE(property_rid::text, '')),
             (COALESCE(publisher_domain, '')),
             evidence) WHERE deleted_at IS NULL
DO NOTHING;

COMMIT;
