-- catalog_agent_authorizations — base table for agent → publisher /
-- agent → property authorizations in the property registry catalog.
-- Replaces the two parallel legacy tables:
--   * agent_property_authorizations (migration 026)   per-property auth
--   * agent_publisher_authorizations (migration 025)  per-publisher auth + agent claims
--
-- Sequencing in #3177:
--   PR 1 (#3195) — publishers cache + override layer schema
--   PR 2 (#3218) — crawler dual-write
--   PR 3 (#3221) — reader baseline tests
--   PR 4a (#3244) — property-side reader cutover
--   PR 4b-prereq (this migration) — auth-side schema + backfill
--   PR 4b-feed     — change-feed entity_type='authorization' wire format
--   PR 4b          — writer extension + reader cutover + snapshot endpoints
--   PR 5           — drop the legacy tables
--
-- Design intent and rationale: see specs/registry-authorization-model.md.
-- This migration only creates the empty schema + view + trigger. Writers
-- and readers continue to use the legacy tables until PR 4b cuts over.

-- =============================================================================
-- 1. catalog_agent_authorizations — base table
-- =============================================================================

CREATE TABLE catalog_agent_authorizations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Monotonic sync cursor for the change-feed emitter and view-layer
  -- pagination. NEVER crosses the wire — consumers see UUIDv7 event_ids
  -- on the change feed, not seq_no. The trigger below rotates seq_no on
  -- soft-delete so revocation events surface to delta consumers.
  seq_no               BIGSERIAL NOT NULL UNIQUE,

  -- agent_url is the raw declared value; agent_url_canonical is what
  -- UNIQUE and indexes use. Mirrors the override layer's column pair so
  -- the override JOIN composes (see v_effective_agent_authorizations
  -- below). Writer applies AdCP URL canonicalization rules
  -- (docs/reference/url-canonicalization). Wildcard '*' is a sentinel
  -- explicitly carved out in the CHECK below.
  agent_url            TEXT NOT NULL,
  agent_url_canonical  TEXT NOT NULL,

  -- Scope: exactly one of (property_rid IS NOT NULL) or
  -- (publisher_domain IS NOT NULL) is true per row, enforced by
  -- chk_caa_publisher_domain_scope. Per-property rows derive
  -- publisher via JOIN on property_rid → catalog_properties.created_by;
  -- denormalizing publisher_domain on per-property rows risks drift.
  property_rid         UUID REFERENCES catalog_properties(property_rid),
  publisher_domain     TEXT,

  -- The publisher's manifest-declared slug, distinct from property_rid.
  -- Carried so the override layer (which keys on property_id slug, not
  -- catalog rid) can JOIN against this table without a translation.
  property_id_slug     TEXT,

  -- Free-text scope from the manifest. Length-capped to match the
  -- adagents.json schema's 500-char limit on authorized_for.
  authorized_for       TEXT
    CHECK (authorized_for IS NULL OR length(authorized_for) <= 500),

  -- Trust signal. Sole source of truth — there's no separate confidence
  -- column. catalog_identifiers' four-value scale doesn't carry over
  -- (authorization has only three real trust states; weak has no clean
  -- meaning). Future evidence sources land as new evidence values, not
  -- new gradations.
  evidence             TEXT NOT NULL
    CHECK (evidence IN ('adagents_json', 'agent_claim', 'community')),

  disputed             BOOLEAN NOT NULL DEFAULT FALSE,

  -- 'system' for auto-projected adagents_json rows; member_id for
  -- community-curated rows; the asserting agent's URL for agent_claim
  -- rows. The agent_claim case is the load-bearing one — it's how
  -- claims get revoked when an asserting agent loses trust ("delete
  -- WHERE evidence='agent_claim' AND created_by=<that_url>").
  created_by           TEXT,

  -- Only meaningful for evidence='agent_claim' rows. Legacy
  -- agent_publisher_authorizations had this; preserved. adagents_json
  -- rows refresh on every successful crawl, so a stale row means the
  -- publisher stopped declaring the auth and the row should soft-delete
  -- rather than expire on a TTL.
  expires_at           TIMESTAMPTZ,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Human-readable change time for admin tooling. NOT a sync cursor —
  -- now() ties under batched writes (cacheAdagentsManifest writes
  -- thousands of rows in a single transaction with identical
  -- updated_at), so a paginating consumer would silently miss the rest
  -- of the batch. Use seq_no for sync.
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Soft-delete tombstone. Tombstones live for 90 days (matching the
  -- change-feed retention window) before the catalog cleanup job
  -- hard-deletes them. Consumers behind the retention get HTTP 410
  -- and re-snapshot.
  deleted_at           TIMESTAMPTZ,

  -- Schema invariants — push design rules into the database so a buggy
  -- writer cannot silently produce inconsistent rows.

  -- URL canonicalization. Full canonicalization is the writer's job;
  -- schema enforces lowercase + no trailing slash + no embedded '*' so
  -- two writers cannot diverge on the simplest cases. '*' is the
  -- wildcard sentinel and is exact-match only — embedded wildcards
  -- (e.g. '*foo*' or '*.example.com') are rejected so the column can
  -- never carry a value that any reader would interpret as a glob.
  CONSTRAINT chk_caa_agent_url_canonical
    CHECK (agent_url_canonical = '*'
        OR (agent_url_canonical = lower(agent_url_canonical)
        AND agent_url_canonical NOT LIKE '%/'
        AND agent_url_canonical NOT LIKE '%*%')),

  -- Mutually exclusive scope: per-property rows don't carry
  -- publisher_domain (derived via JOIN); publisher-wide rows have
  -- property_rid IS NULL.
  CONSTRAINT chk_caa_publisher_domain_scope
    CHECK ((property_rid IS NULL AND publisher_domain IS NOT NULL)
        OR (property_rid IS NOT NULL AND publisher_domain IS NULL)),

  -- expires_at is only meaningful for agent_claim. adagents_json /
  -- community rows refresh / are managed by other means.
  CONSTRAINT chk_caa_expires_only_for_claims
    CHECK (expires_at IS NULL OR evidence = 'agent_claim'),

  -- agent_claim rows MUST identify the asserting agent in created_by.
  -- The documented revocation path ("DELETE WHERE evidence='agent_claim'
  -- AND created_by=<agent_url>") is unenforceable on rows where
  -- created_by IS NULL — the row would live forever even after the
  -- claiming agent loses trust. Treat created_by as a load-bearing
  -- column for the agent_claim case.
  CONSTRAINT chk_caa_claim_has_created_by
    CHECK (evidence <> 'agent_claim' OR created_by IS NOT NULL)
);

-- Active-set partial unique: one row per (agent, scope, evidence) when
-- live. Tombstones accumulate without conflict (preserves audit trail).
-- COALESCE handles NULLs (Postgres treats them as distinct in plain
-- UNIQUE). The (agent_url_canonical, property_rid_or_publisher_domain,
-- evidence) keying matches the legacy
-- agent_publisher_authorizations.UNIQUE(agent_url, publisher_domain,
-- source) — design intent: one claim per (agent, scope, source); second
-- writer wins for agent_claim rows.
CREATE UNIQUE INDEX idx_caa_unique_active
  ON catalog_agent_authorizations
  (agent_url_canonical,
   COALESCE(property_rid::text, ''),
   COALESCE(publisher_domain, ''),
   evidence)
  WHERE deleted_at IS NULL;

-- Reader indexes — partial WHERE deleted_at IS NULL, mirroring the
-- override layer's WHERE superseded_at IS NULL pattern. Composite
-- columns serve the legacy bulkGetFirstAuthForAgents secondary sort
-- (ORDER BY agent_url, source, publisher_domain) without an in-memory
-- re-sort.
CREATE INDEX idx_caa_by_agent
  ON catalog_agent_authorizations (agent_url_canonical, evidence, publisher_domain)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_caa_by_publisher
  ON catalog_agent_authorizations (publisher_domain)
  WHERE publisher_domain IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_caa_by_property
  ON catalog_agent_authorizations (property_rid)
  WHERE property_rid IS NOT NULL AND deleted_at IS NULL;

-- Override JOIN index — matches the v_effective_agent_authorizations
-- view's anti-join keys exactly: (agent_url_canonical, publisher_domain,
-- property_id_slug). The `evidence='adagents_json'` partial filter
-- skips rows the override layer doesn't apply to (claims and community
-- pass through untouched).
CREATE INDEX idx_caa_override_join
  ON catalog_agent_authorizations (agent_url_canonical, publisher_domain, property_id_slug)
  WHERE deleted_at IS NULL AND evidence = 'adagents_json';

-- Sync index — NOT partial. Tombstones must be visible to delta
-- consumers so they can apply deletions locally. Without seeing the
-- tombstone in the feed, a consumer cannot distinguish "no row in this
-- delta" from "row was removed since my last sync."
CREATE INDEX idx_caa_seq ON catalog_agent_authorizations (seq_no);

-- TTL cleanup index. The catalog cleanup job hard-deletes tombstoned
-- rows older than 90 days and expired agent_claim rows.
CREATE INDEX idx_caa_expires
  ON catalog_agent_authorizations (expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_caa_tombstone_ttl
  ON catalog_agent_authorizations (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- =============================================================================
-- 2. seq_no rotation trigger — security-relevant
-- =============================================================================
-- A row that's tombstoned without a fresh seq_no is invisible to delta
-- consumers (their cursor moved past the row's original seq_no when it
-- was created), so revocations silently never propagate. This is a
-- security failure mode: a revoked authorization continues to live in
-- DSPs' local caches forever. Enforced at the schema level so writer
-- discipline isn't load-bearing.

CREATE FUNCTION caa_rotate_seq_no_on_tombstone() RETURNS trigger AS $$
BEGIN
  -- Rotate on every transition that crosses the live/tombstoned boundary —
  -- both directions. Tombstone (NULL → NOT NULL) is the obvious case;
  -- un-tombstone (NOT NULL → NULL) is just as load-bearing because a
  -- resurrected row otherwise re-enters the active set with its old
  -- seq_no, which is older than every active consumer's cursor — the
  -- resurrection silently never propagates.
  IF (OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL) THEN
    NEW.seq_no := nextval('catalog_agent_authorizations_seq_no_seq');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_caa_rotate_seq_no
  BEFORE UPDATE ON catalog_agent_authorizations
  FOR EACH ROW EXECUTE FUNCTION caa_rotate_seq_no_on_tombstone();

-- =============================================================================
-- 3. v_effective_agent_authorizations — applies the override layer
-- =============================================================================
-- LEFT JOIN against adagents_authorization_overrides doesn't compose
-- because 'add' overrides need to surface phantom rows where there's
-- no base row to anchor — that's the dominant 'add' use case
-- (publisher's file is broken or missing). UNION ALL handles both arms
-- explicitly.
--
-- Override layer is scoped to evidence='adagents_json' rows only.
-- Applying it to agent_claim rows doesn't make semantic sense — claims
-- get revoked via created_by-based delete instead.

CREATE VIEW v_effective_agent_authorizations AS
WITH base AS (
  SELECT
    caa.id,
    caa.agent_url,
    caa.agent_url_canonical,
    caa.property_rid,
    caa.property_id_slug,
    -- For per-property rows, derive publisher from the property's
    -- source pipeline. The strip generalizes across pipeline prefixes
    -- ('adagents_json:foo.example', 'community:foo.example', etc.) so
    -- adding a new pipeline doesn't break the view. The right
    -- long-term fix is a dedicated publisher_domain column on
    -- catalog_properties; tracked separately.
    COALESCE(caa.publisher_domain,
             regexp_replace(cp.created_by, '^[^:]+:', '')) AS publisher_domain,
    caa.authorized_for,
    caa.evidence,
    caa.disputed,
    caa.created_by,
    caa.expires_at,
    caa.created_at,
    caa.updated_at,
    caa.seq_no
  FROM catalog_agent_authorizations caa
  LEFT JOIN catalog_properties cp ON cp.property_rid = caa.property_rid
  WHERE caa.deleted_at IS NULL
)
-- Arm 1: base rows surface UNLESS a matching active 'suppress' override
-- exists. Override layer is scoped to evidence='adagents_json'; claim
-- rows pass through.
SELECT
  b.*,
  FALSE AS override_applied,
  NULL::text AS override_reason
FROM base b
WHERE b.evidence <> 'adagents_json'
   OR NOT EXISTS (
     SELECT 1 FROM adagents_authorization_overrides ov
     WHERE ov.superseded_at IS NULL
       AND ov.override_type = 'suppress'
       AND ov.host_domain = b.publisher_domain
       AND ov.agent_url_canonical = b.agent_url_canonical
       -- A host-wide suppress (override.property_id IS NULL) hides every
       -- base row under that publisher, both per-property and publisher-wide.
       -- A per-property suppress only hides matching slug.
       AND (ov.property_id IS NULL OR ov.property_id = b.property_id_slug)
   )
UNION ALL
-- Arm 2: active 'add' overrides surface as effective rows regardless
-- of base. property_rid is NULL on these rows because the override
-- references a slug; consumers needing property metadata JOIN through
-- (publisher_domain, property_id_slug) against catalog_properties.
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
  ov.override_reason
FROM adagents_authorization_overrides ov
WHERE ov.superseded_at IS NULL
  AND ov.override_type = 'add';

COMMENT ON VIEW v_effective_agent_authorizations IS
  'Effective agent authorization set: catalog_agent_authorizations '
  'base rows minus active suppress overrides, UNION ALL active add '
  'overrides. Override layer is scoped to evidence=''adagents_json'' '
  'only; agent_claim and community rows pass through. See '
  'specs/registry-authorization-model.md for design intent.';
