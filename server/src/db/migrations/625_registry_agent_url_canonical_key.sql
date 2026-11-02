-- Registry agent-URL keys follow AdCP URL canonicalization (#7830).
--
-- Before this migration the registry key was `lower(trim(url))` with every
-- trailing slash stripped. The spec (docs/reference/url-canonicalization)
-- lowercases only the scheme and host and treats path case and a non-root
-- trailing slash as significant, so the old key merged agents the spec says
-- are different: an authorization, a compliance badge, or an ownership claim
-- could attach to the wrong agent. `chk_caa_agent_url_canonical` (440) and
-- `chk_aao_agent_url_canonical` (432) froze the old shape into the schema.
--
-- The app now computes every key with `registryAgentUrlKey`
-- (server/src/db/registry-agent-url-key.ts). The spec algorithm needs IDN
-- A-label conversion, dot-segment resolution and selective percent-decoding,
-- none of which are practical in SQL, so SQL no longer canonicalizes agent
-- URLs at all — queries take keys the app already computed.
--
-- WHAT THIS MIGRATION DOES
--   1. Replaces both CHECK constraints with ones that accept the new key
--      shape and still reject everything a key must never contain.
--   2. Adds agent_url / agent_url_canonical to caa_emit_event's
--      modified-event detection, so a key rewrite reaches change-feed
--      consumers instead of leaving them holding the old key forever.
--   3. Widens the suppress join in v_effective_agent_authorizations for
--      bad_actor overrides only, so a ban cannot be lifted by a
--      one-character edit to the publisher's manifest.
--
-- NOTE FOR A REBUILT DATABASE
--   Migrations 441, 488, 541 and 570 contain one-shot backfills that compute
--   keys with the old LOWER(RTRIM(BTRIM(...))) rule. They are already applied
--   in production and are not rewritten here (released migrations are
--   immutable). A database rebuilt from scratch — staging, DR — replays them
--   and lands old-form keys that nothing corrects, because the rewrite is an
--   operator-run script rather than a migration. Run
--   `migrate-registry-agent-url-keys.ts --apply` as part of any such
--   bootstrap.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   Rewrite stored keys. Recomputing a key means running the app algorithm,
--   and merging or splitting rows whose old key collided is a decision with
--   authorization, ownership and credential consequences that a blind UPDATE
--   must not make. The rewrite is
--   `server/src/scripts/migrate-registry-agent-url-keys.ts`, which is dry-run
--   by default, reports every collision class, and refuses to write while any
--   collision is unresolved. Run
--   `server/src/scripts/audit-agent-url-canonicalization-collisions.ts`
--   against production first.
--
-- Both constraints are added NOT VALID on purpose. They are enforced for
-- every insert and update from this point on — including the backfill's own
-- writes — but existing rows are not scanned, so a legacy key that the new
-- shape rejects (an un-stripped fragment, say) cannot fail the deploy before
-- the backfill has had a chance to run. The backfill runs
-- `VALIDATE CONSTRAINT` once it has rewritten every row, which is what turns
-- "enforced going forward" into "proven for the whole table".

BEGIN;

-- =============================================================================
-- catalog_agent_authorizations
-- =============================================================================

ALTER TABLE catalog_agent_authorizations
  DROP CONSTRAINT chk_caa_agent_url_canonical;

-- '*' is the exact-match wildcard sentinel. Otherwise the value must look
-- like a registry key:
--   * an absolute http(s) URL with a lowercase scheme;
--   * a lowercase authority with no userinfo (an uppercase host or a
--     `user:pass@` prefix means the writer skipped canonicalization);
--   * no embedded '*' (any reader could misread it as a glob), backslash
--     (WHATWG parsing folds it to '/', so the key would not round-trip),
--     whitespace or control character (unmatchable by any lookup caller);
--   * no fragment — canonicalization drops it;
--   * no trailing '/' on the path, anywhere. Path CASE is significant — that
--     is the P0 fix — but a trailing slash is folded for registry identity:
--     `/mcp` and `/mcp/` are one agent. The single exception is a root path
--     carrying a query (`https://x.example/?t=1`), where the slash is kept so
--     the query still reads as a query. Authorization matching keeps the
--     trailing slash significant and never reads this column; see
--     server/src/db/registry-agent-url-key.ts.
--
-- The authority class mirrors CANONICAL_AUTHORITY in
-- server/src/db/registry-agent-url-key.ts. The two MUST stay in step: a key
-- the app emits but this rejects is a publisher-triggerable write failure
-- that aborts a whole manifest projection. An integration test fuzzes the
-- printable range against both.
ALTER TABLE catalog_agent_authorizations
  ADD CONSTRAINT chk_caa_agent_url_canonical
  CHECK (
    agent_url_canonical = '*'
    OR (
      agent_url_canonical ~ '^https?://'
      AND substring(agent_url_canonical from '^https?://([^/?#]*)')
          ~ '^[a-z0-9._~!$&''()+,;=:[\]-]+$'
      AND agent_url_canonical !~ '[*\\#]'
      AND agent_url_canonical !~ '[[:space:][:cntrl:]]'
      AND (
        split_part(agent_url_canonical, '?', 1) !~ '/$'
        OR (agent_url_canonical ~ '\?'
            AND split_part(agent_url_canonical, '?', 1) ~ '^https?://[^/?#]+/$')
      )
    )
  ) NOT VALID;

COMMENT ON COLUMN catalog_agent_authorizations.agent_url_canonical IS
  'Registry key for agent_url, computed by registryAgentUrlKey in '
  'server/src/db/registry-agent-url-key.ts (AdCP URL canonicalization, '
  'root slash dropped). Path case and a non-root trailing slash are '
  'significant. Never recomputed in SQL — see #7830.';

-- =============================================================================
-- adagents_authorization_overrides
-- =============================================================================
-- Same shape, minus the wildcard: the override layer has never carried '*'
-- (migration 432's constraint had no carve-out for it), so this one keeps
-- rejecting it rather than quietly widening the override surface.

ALTER TABLE adagents_authorization_overrides
  DROP CONSTRAINT chk_aao_agent_url_canonical;

ALTER TABLE adagents_authorization_overrides
  ADD CONSTRAINT chk_aao_agent_url_canonical
  CHECK (
    agent_url_canonical ~ '^https?://'
    AND substring(agent_url_canonical from '^https?://([^/?#]*)')
        ~ '^[a-z0-9._~!$&''()+,;=:[\]-]+$'
    AND agent_url_canonical !~ '[*\\#]'
    AND agent_url_canonical !~ '[[:space:][:cntrl:]]'
    AND (
      split_part(agent_url_canonical, '?', 1) !~ '/$'
      OR (agent_url_canonical ~ '\?'
          AND split_part(agent_url_canonical, '?', 1) ~ '^https?://[^/?#]+/$')
    )
  ) NOT VALID;

COMMENT ON COLUMN adagents_authorization_overrides.agent_url_canonical IS
  'Registry key for agent_url, computed by registryAgentUrlKey in '
  'server/src/db/registry-agent-url-key.ts. See #7830.';

-- =============================================================================
-- caa_emit_event — a key rewrite is a change consumers must see
-- =============================================================================
-- Carried forward verbatim from migration 570 apart from the modified-event
-- condition; see the comment on that branch.

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
      NULL, NEW.signing_keys, NEW.collections
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
        NULL, OLD.signing_keys, OLD.collections
      );
    ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
      ev_type := 'authorization.granted';
      ev_payload := caa_event_payload(
        NEW.id, NEW.agent_url, NEW.agent_url_canonical,
        NEW.property_rid, NEW.property_id_slug, NEW.publisher_domain,
        NEW.authorized_for, NEW.evidence, NEW.disputed,
        NEW.created_by, NEW.expires_at,
        NEW.created_at, NEW.updated_at, NEW.seq_no,
        NULL, NEW.signing_keys, NEW.collections
      );
    -- agent_url_canonical joins the modified-detection set (#7830). It is an
    -- externally-visible payload field, so a key rewrite that did not emit
    -- here would leave every delta consumer holding the old key forever,
    -- with nothing on the feed to tell them otherwise.
    ELSIF NEW.deleted_at IS NULL
      AND (OLD.authorized_for       IS DISTINCT FROM NEW.authorized_for
        OR OLD.expires_at           IS DISTINCT FROM NEW.expires_at
        OR OLD.disputed             IS DISTINCT FROM NEW.disputed
        OR OLD.signing_keys         IS DISTINCT FROM NEW.signing_keys
        OR OLD.collections          IS DISTINCT FROM NEW.collections
        OR OLD.agent_url_canonical  IS DISTINCT FROM NEW.agent_url_canonical
        OR OLD.agent_url            IS DISTINCT FROM NEW.agent_url) THEN
      ev_type := 'authorization.modified';
      ev_payload := caa_event_payload(
        NEW.id, NEW.agent_url, NEW.agent_url_canonical,
        NEW.property_rid, NEW.property_id_slug, NEW.publisher_domain,
        NEW.authorized_for, NEW.evidence, NEW.disputed,
        NEW.created_by, NEW.expires_at,
        NEW.created_at, NEW.updated_at, NEW.seq_no,
        NULL, NEW.signing_keys, NEW.collections
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
-- v_effective_agent_authorizations — keep a bad-actor ban from being lifted
-- by a one-character manifest edit
-- =============================================================================
-- Carried forward verbatim from migration 570 apart from the suppress join;
-- see the comment on that branch.

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
    caa.signing_keys,
    caa.collections
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
  b.signing_keys,
  b.collections
FROM base b
WHERE b.evidence <> 'adagents_json'
   OR NOT EXISTS (
     SELECT 1 FROM adagents_authorization_overrides ov
     WHERE ov.superseded_at IS NULL
       AND ov.override_type = 'suppress'
       AND ov.host_domain = b.publisher_domain
       AND (
         ov.agent_url_canonical = b.agent_url_canonical
         -- A ban is the one place where the pre-#7830 key's coarseness was
         -- the safer semantics. Exact key equality means a banned agent
         -- walks free the moment the publisher's manifest changes one
         -- character of path case or adds a trailing slash: that is a
         -- different key, so the suppression stops matching, and the
         -- resurrection leaves no trace because the override row is still
         -- active. Fold both sides the way the old key did, for bad_actor
         -- only. Over-suppressing a case variant is the safe direction for
         -- a ban; 'correction' and 'file_broken' overrides stay exact,
         -- because there the moderator is fixing one specific entry and
         -- hiding a genuinely different agent would be wrong.
         OR (ov.override_reason = 'bad_actor'
             AND rtrim(lower(ov.agent_url_canonical), '/')
               = rtrim(lower(b.agent_url_canonical), '/'))
       )
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
  NULL::jsonb AS signing_keys,
  NULL::jsonb AS collections
FROM adagents_authorization_overrides ov
WHERE ov.superseded_at IS NULL
  AND ov.override_type = 'add';

COMMIT;
