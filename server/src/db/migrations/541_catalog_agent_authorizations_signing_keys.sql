-- Project authorized_agents[*].signing_keys into
-- catalog_agent_authorizations so the /registry/authorizations reader
-- and the authorization.* change-feed events surface the publisher's
-- pinned JWKs. Consumers verifying inbound TMP signatures (adcp-go
-- LazyAuthorizationKeyStore) key on kid → JWK from the response body;
-- without this column they had no keys and all signature checks failed.
--
-- Migration 440 shipped the base table with columns for evidence,
-- authorized_for, scope, and expiry — but not signing_keys. The manifest
-- parser accepts them (`AdagentsAuthorizedAgentSchema` at
-- server/src/schemas/registry.ts:81 admits the array; per-entry kid/kty
-- validation runs in server/src/adagents-manager.ts:1083-1116), and
-- publishers.adagents_json JSONB (migration 432) already stores the raw
-- manifest verbatim — so the fix is purely catalog-projection. Reader,
-- writer, view, and change-feed emitter all need to carry the new
-- column through.
--
-- Design note: signing_keys is an array of JWKs per the adagents.json
-- schema. Stored as JSONB, not per-key rows, because (a) the registry
-- never queries by kid — consumers do that in-process — and (b) the
-- publisher's file is the source of truth for the set, so partial-row
-- writes have no meaning. Full replace on every crawl matches the
-- authorized_for / disputed columns' semantics.
--
-- Ordering matters below:
--   1. ADD COLUMN — schema first so subsequent statements can reference it.
--   2. Backfill UPDATE — the still-old caa_emit_event() checks only
--      authorized_for/expires_at/disputed for modified emission, so the
--      backfill runs SILENTLY. This is deliberate: a prod backfill over
--      thousands of rows would otherwise flood /registry/feed with
--      modified events, and the correct steady-state notification path
--      is a one-shot snapshot pull by each consumer after this migration.
--   3. caa_event_payload — extend the shared payload builder.
--   4. caa_emit_event — add signing_keys to the modified detection.
--      From this point forward, key rotations emit modified events.
--   5. v_effective_agent_authorizations — expose the column via the
--      reader. Placed last so any in-flight snapshot read completes
--      against the old shape before the new one appears.

BEGIN;

-- =============================================================================
-- 1. Column
-- =============================================================================

ALTER TABLE catalog_agent_authorizations
  ADD COLUMN signing_keys JSONB;

COMMENT ON COLUMN catalog_agent_authorizations.signing_keys IS
  'Publisher-pinned JWK set from authorized_agents[*].signing_keys in adagents.json. '
  'Array of JWK objects (kid + kty + kty-specific fields per RFC 7517). NULL when '
  'the publisher declared no keys — consumers fall back to the agent-hosted JWKS '
  'per spec R-2 (docs/governance/property/adagents.mdx). Only meaningful for '
  'evidence=''adagents_json'' rows; agent_claim / community / adagents_authoritative '
  'rows carry NULL because those trust sources do not pin keys.';

-- =============================================================================
-- 2. Backfill from publishers.adagents_json (silent — trigger still old)
-- =============================================================================
-- Match each existing evidence='adagents_json' row to its source manifest
-- entry by (publisher_domain, canonicalized agent_url). For per-property
-- rows publisher_domain is NULL, so derive it via catalog_properties the
-- same way v_effective_agent_authorizations does (regexp_replace of
-- created_by strips the 'adagents_json:' prefix).
--
-- Canonicalization on the manifest side must match what publisher-db.ts
-- canonicalizeAgentUrl does: lowercase + strip trailing slash. Trim
-- whitespace first because the manifest is user-authored. Full
-- canonicalization is deferred to the writer; this backfill catches the
-- common case (no URL rewrites, only case/slash normalization).

WITH manifest_keys AS (
  SELECT
    pub.domain AS publisher_domain,
    LOWER(RTRIM(BTRIM(agent->>'url'), '/')) AS agent_url_canonical,
    agent->'signing_keys' AS signing_keys
  FROM publishers pub,
    LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(pub.adagents_json->'authorized_agents') = 'array'
           THEN pub.adagents_json->'authorized_agents'
           ELSE '[]'::jsonb END
    ) AS agent
  WHERE jsonb_typeof(agent->'signing_keys') = 'array'
    AND jsonb_typeof(agent->'url') = 'string'
),
caa_with_publisher AS (
  -- Mirror v_effective_agent_authorizations' publisher derivation so the
  -- match keys align with the writer's projection: publisher-wide rows
  -- have publisher_domain set; per-property rows resolve it via the
  -- 'adagents_json:<domain>' prefix on catalog_properties.created_by.
  SELECT
    caa.id,
    caa.agent_url_canonical,
    COALESCE(caa.publisher_domain,
             regexp_replace(cp.created_by, '^[^:]+:', '')) AS derived_publisher
  FROM catalog_agent_authorizations caa
  LEFT JOIN catalog_properties cp ON cp.property_rid = caa.property_rid
  WHERE caa.evidence = 'adagents_json'
    AND caa.deleted_at IS NULL
)
UPDATE catalog_agent_authorizations target
   SET signing_keys = mk.signing_keys
  FROM manifest_keys mk
  JOIN caa_with_publisher cwp
    ON cwp.agent_url_canonical = mk.agent_url_canonical
   AND cwp.derived_publisher   = mk.publisher_domain
 WHERE target.id = cwp.id;

-- =============================================================================
-- 3. caa_event_payload — extend payload builder with signing_keys
-- =============================================================================
-- New trailing param carries the column value from the caller so the
-- helper stays pure (no extra DB round-trip per event). The AAO fan-out
-- trigger already SELECTs caa.* into loop_rec, so signing_keys rides
-- along at zero cost.
--
-- Placement in the returned JSONB: after 'seq_no' and before the
-- override_* keys, keeping the base-row fields grouped ahead of the
-- override overlay fields. Consumers (adcp-go LazyAuthorizationKeyStore)
-- read by key name, not by position.

CREATE OR REPLACE FUNCTION caa_event_payload(
  caa_id uuid,
  agent_url text,
  agent_url_canonical text,
  property_rid uuid,
  property_id_slug text,
  publisher_domain text,
  authorized_for text,
  evidence text,
  disputed boolean,
  created_by text,
  expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  seq_no bigint,
  precomputed_publisher text DEFAULT NULL,
  signing_keys jsonb DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  derived_publisher text;
BEGIN
  IF publisher_domain IS NOT NULL THEN
    derived_publisher := publisher_domain;
  ELSIF precomputed_publisher IS NOT NULL THEN
    derived_publisher := precomputed_publisher;
  ELSIF property_rid IS NOT NULL THEN
    SELECT regexp_replace(cp.created_by, '^[^:]+:', '')
      INTO derived_publisher
      FROM catalog_properties cp
     WHERE cp.property_rid = caa_event_payload.property_rid;
  END IF;

  RETURN jsonb_build_object(
    'id',                 caa_id,
    'agent_url',          agent_url,
    'agent_url_canonical', agent_url_canonical,
    'property_rid',       property_rid,
    'property_id_slug',   property_id_slug,
    'publisher_domain',   derived_publisher,
    'authorized_for',     authorized_for,
    'evidence',           evidence,
    'disputed',           disputed,
    'created_by',         created_by,
    'expires_at',         expires_at,
    'created_at',         created_at,
    'updated_at',         updated_at,
    'seq_no',             seq_no,
    'signing_keys',       signing_keys,
    'override_applied',   FALSE,
    'override_reason',    NULL
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- 4. caa_emit_event — include signing_keys in modified detection + payload
-- =============================================================================
-- signing_keys rotation IS an externally-visible change: consumers cache
-- kid → JWK maps and need to invalidate on rotation. Adding it to the
-- IS DISTINCT FROM triad matches the design comment on the trigger
-- ("only when an externally-visible field changed").
--
-- Called immediately after caa_event_payload is replaced above so
-- CREATE OR REPLACE of this function picks up the new payload signature.

CREATE OR REPLACE FUNCTION caa_emit_event() RETURNS trigger AS $$
DECLARE
  ev_payload jsonb;
  ev_type text;
  ev_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    ev_type := 'authorization.granted';
    ev_payload := caa_event_payload(
      NEW.id, NEW.agent_url, NEW.agent_url_canonical,
      NEW.property_rid, NEW.property_id_slug, NEW.publisher_domain,
      NEW.authorized_for, NEW.evidence, NEW.disputed,
      NEW.created_by, NEW.expires_at,
      NEW.created_at, NEW.updated_at, NEW.seq_no,
      NULL, NEW.signing_keys
    );
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      ev_type := 'authorization.revoked';
      ev_payload := caa_event_payload(
        OLD.id, OLD.agent_url, OLD.agent_url_canonical,
        OLD.property_rid, OLD.property_id_slug, OLD.publisher_domain,
        OLD.authorized_for, OLD.evidence, OLD.disputed,
        OLD.created_by, OLD.expires_at,
        OLD.created_at, OLD.updated_at, NEW.seq_no,
        NULL, OLD.signing_keys
      );
    ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
      ev_type := 'authorization.granted';
      ev_payload := caa_event_payload(
        NEW.id, NEW.agent_url, NEW.agent_url_canonical,
        NEW.property_rid, NEW.property_id_slug, NEW.publisher_domain,
        NEW.authorized_for, NEW.evidence, NEW.disputed,
        NEW.created_by, NEW.expires_at,
        NEW.created_at, NEW.updated_at, NEW.seq_no,
        NULL, NEW.signing_keys
      );
    ELSIF NEW.deleted_at IS NULL
      AND (OLD.authorized_for IS DISTINCT FROM NEW.authorized_for
        OR OLD.expires_at     IS DISTINCT FROM NEW.expires_at
        OR OLD.disputed       IS DISTINCT FROM NEW.disputed
        OR OLD.signing_keys   IS DISTINCT FROM NEW.signing_keys) THEN
      ev_type := 'authorization.modified';
      ev_payload := caa_event_payload(
        NEW.id, NEW.agent_url, NEW.agent_url_canonical,
        NEW.property_rid, NEW.property_id_slug, NEW.publisher_domain,
        NEW.authorized_for, NEW.evidence, NEW.disputed,
        NEW.created_by, NEW.expires_at,
        NEW.created_at, NEW.updated_at, NEW.seq_no,
        NULL, NEW.signing_keys
      );
    ELSE
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  ev_id := uuidv7();
  INSERT INTO catalog_events (event_id, event_type, entity_type, entity_id, payload, actor)
  VALUES (
    ev_id,
    ev_type,
    'authorization',
    COALESCE((ev_payload->>'id'), NEW.id::text),
    ev_payload,
    'trigger:caa_emit_event'
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 5. aao_emit_event — pass signing_keys through the AAO fan-out
-- =============================================================================
-- The 'suppress' fan-out loop reads caa.* into loop_rec, so signing_keys
-- is already available; wire it into the caa_event_payload call so the
-- override-driven revoked / granted events carry the base row's keys.
-- 'add' phantom overrides carry no base row, so signing_keys stays NULL
-- for those (aao_override_payload with effective_payload=NULL builds
-- the JSONB directly and never gets a signing_keys value — matches the
-- prior column absence).

CREATE OR REPLACE FUNCTION aao_emit_event() RETURNS trigger AS $$
DECLARE
  loop_rec record;
  ev_id uuid;
  ev_type text;
  ev_payload jsonb;
  base_payload jsonb;
  matched_count int := 0;
  is_active_insert boolean;
  is_supersede boolean;
  ov_row adagents_authorization_overrides;
BEGIN
  is_active_insert := TG_OP = 'INSERT' AND NEW.superseded_at IS NULL;
  is_supersede := TG_OP = 'UPDATE'
              AND OLD.superseded_at IS NULL
              AND NEW.superseded_at IS NOT NULL;

  IF NOT is_active_insert AND NOT is_supersede THEN
    RETURN NEW;
  END IF;

  IF is_supersede THEN
    ov_row := OLD;
  ELSE
    ov_row := NEW;
  END IF;

  IF ov_row.override_type = 'add' THEN
    IF is_active_insert THEN
      ev_type := 'authorization.granted';
    ELSE
      ev_type := 'authorization.revoked';
    END IF;
    ev_payload := aao_override_payload(ov_row, NULL, NULL, is_active_insert);
    ev_id := uuidv7();
    INSERT INTO catalog_events (event_id, event_type, entity_type, entity_id, payload, actor)
    VALUES (
      ev_id, ev_type, 'authorization',
      ov_row.id::text, ev_payload, 'trigger:aao_emit_event'
    );
    RETURN NEW;
  END IF;

  IF is_active_insert THEN
    ev_type := 'authorization.revoked';
  ELSE
    ev_type := 'authorization.granted';
  END IF;

  FOR loop_rec IN
    SELECT caa.*,
           regexp_replace(cp.created_by, '^[^:]+:', '') AS derived_publisher
      FROM catalog_agent_authorizations caa
      LEFT JOIN catalog_properties cp ON cp.property_rid = caa.property_rid
     WHERE caa.deleted_at IS NULL
       AND caa.evidence = 'adagents_json'
       AND caa.agent_url_canonical = ov_row.agent_url_canonical
       AND COALESCE(caa.publisher_domain,
                    regexp_replace(cp.created_by, '^[^:]+:', ''))
           = ov_row.host_domain
       AND (ov_row.property_id IS NULL OR ov_row.property_id = caa.property_id_slug)
  LOOP
    base_payload := caa_event_payload(
      loop_rec.id, loop_rec.agent_url, loop_rec.agent_url_canonical,
      loop_rec.property_rid, loop_rec.property_id_slug, loop_rec.publisher_domain,
      loop_rec.authorized_for, loop_rec.evidence, loop_rec.disputed,
      loop_rec.created_by, loop_rec.expires_at,
      loop_rec.created_at, loop_rec.updated_at, loop_rec.seq_no,
      loop_rec.derived_publisher, loop_rec.signing_keys
    );
    ev_payload := aao_override_payload(ov_row, loop_rec.id::text, base_payload, is_active_insert);
    ev_id := uuidv7();
    INSERT INTO catalog_events (event_id, event_type, entity_type, entity_id, payload, actor)
    VALUES (
      ev_id, ev_type, 'authorization',
      loop_rec.id::text, ev_payload, 'trigger:aao_emit_event'
    );
    matched_count := matched_count + 1;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 6. v_effective_agent_authorizations — surface signing_keys on the reader
-- =============================================================================
-- CREATE OR REPLACE VIEW accepts additive column changes at the end of
-- the projection list. Arm 1 (base rows) carries caa.signing_keys; arm 2
-- ('add' overrides) has no base row, so signing_keys is NULL — matches
-- aao_override_payload's shape for phantom rows.

-- signing_keys is appended AFTER the existing column list. CREATE OR
-- REPLACE VIEW only permits adding new columns to the END of the
-- projection — column-position swaps are rejected as a rename. Order
-- here matches the base view's historical layout (id … seq_no,
-- override_applied, override_reason) with signing_keys as the new
-- trailing column.

CREATE OR REPLACE VIEW v_effective_agent_authorizations AS
WITH base AS (
  SELECT
    caa.id,
    caa.agent_url,
    caa.agent_url_canonical,
    caa.property_rid,
    caa.property_id_slug,
    COALESCE(caa.publisher_domain,
             regexp_replace(cp.created_by, '^[^:]+:', '')) AS publisher_domain,
    caa.authorized_for,
    caa.evidence,
    caa.disputed,
    caa.created_by,
    caa.expires_at,
    caa.created_at,
    caa.updated_at,
    caa.seq_no,
    caa.signing_keys
  FROM catalog_agent_authorizations caa
  LEFT JOIN catalog_properties cp ON cp.property_rid = caa.property_rid
  WHERE caa.deleted_at IS NULL
)
SELECT
  b.id,
  b.agent_url,
  b.agent_url_canonical,
  b.property_rid,
  b.property_id_slug,
  b.publisher_domain,
  b.authorized_for,
  b.evidence,
  b.disputed,
  b.created_by,
  b.expires_at,
  b.created_at,
  b.updated_at,
  b.seq_no,
  FALSE AS override_applied,
  NULL::text AS override_reason,
  b.signing_keys
FROM base b
WHERE b.evidence <> 'adagents_json'
   OR NOT EXISTS (
     SELECT 1 FROM adagents_authorization_overrides ov
     WHERE ov.superseded_at IS NULL
       AND ov.override_type = 'suppress'
       AND ov.host_domain = b.publisher_domain
       AND ov.agent_url_canonical = b.agent_url_canonical
       AND (ov.property_id IS NULL OR ov.property_id = b.property_id_slug)
   )
UNION ALL
SELECT
  ov.id,
  ov.agent_url,
  ov.agent_url_canonical,
  NULL::uuid AS property_rid,
  ov.property_id AS property_id_slug,
  ov.host_domain AS publisher_domain,
  ov.authorized_for,
  'override'::text AS evidence,
  FALSE AS disputed,
  ov.approved_by_user_id AS created_by,
  NULL::timestamptz AS expires_at,
  ov.created_at,
  ov.created_at AS updated_at,
  NULL::bigint AS seq_no,
  TRUE AS override_applied,
  ov.override_reason,
  NULL::jsonb AS signing_keys
FROM adagents_authorization_overrides ov
WHERE ov.superseded_at IS NULL
  AND ov.override_type = 'add';

COMMIT;
