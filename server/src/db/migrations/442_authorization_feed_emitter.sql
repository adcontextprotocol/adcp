-- Authorization events on the registry change feed (PR 4b-feed of #3177).
--
-- Postgres triggers emit authorization.granted / authorization.revoked /
-- authorization.modified events into catalog_events whenever the base
-- table (catalog_agent_authorizations, migration 440) or the override
-- layer (adagents_authorization_overrides, migration 432) changes.
--
-- Why triggers, not application-level emission:
--   * The dual-write window (PR 4b shipping in parallel) means the same
--     row can be written by the catalog projection writer AND the
--     legacy crawler path. Trigger emission fires once per actual data
--     change, regardless of which writer caused it. Backfill, ad-hoc
--     admin SQL, and future writers all produce events for free.
--   * Schema 440 already established the precedent: load-bearing
--     sync-correctness invariants live in the schema (seq_no rotation
--     trigger), not in writer discipline.
--   * Triggers run in the same transaction as the data change, so a
--     failed event write rolls the data change back. No half-state.
--
-- Wire format pinned in specs/registry-authorization-model.md
-- ("Change-feed event shape" section). Reader changes: zero — the
-- /api/registry/feed endpoint already supports event_type glob
-- filtering, so consumers subscribe with `?types=authorization.*` and
-- the new events flow through with no API-level work.

-- =============================================================================
-- 1. uuidv7() — PL/pgSQL implementation matching server/src/db/uuid.ts
-- =============================================================================
-- catalog_events.event_id is the change-feed cursor. Migration 348
-- assumes UUIDv7 (time-ordered) so cursor pagination is monotonic.
-- The application generates them via crypto.randomBytes; the trigger
-- needs the same shape produced from the database side. Bit layout
-- exactly matches uuid.ts:
--   48 bits unix ms timestamp
--    4 bits version (0b0111 = 7)
--   12 bits random
--    2 bits variant (0b10)
--   62 bits random

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$
DECLARE
  ts_us        BIGINT;            -- microseconds since epoch
  ts_ms        BIGINT;             -- milliseconds since epoch (high 48 bits)
  us_in_ms     INTEGER;            -- 0-999 microseconds within the millisecond
  rand_bytes   BYTEA;
  ts_bytes     BYTEA;
  result_bytes BYTEA;
  byte6        INTEGER;
  byte7        INTEGER;
BEGIN
  -- Use microsecond precision so calls within the same millisecond are
  -- monotonic — load-bearing for change-feed cursor correctness, where
  -- a granted event followed by a revoked event for the same id must
  -- apply in INSERT order. The standard 48-bit-ms layout would tie on
  -- ms and let random bits flip the order.
  ts_us      := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::BIGINT;
  ts_ms      := ts_us / 1000;
  us_in_ms   := (ts_us % 1000)::INTEGER;  -- fits in 10 bits (max 999)
  rand_bytes := gen_random_bytes(10);

  -- 48-bit big-endian timestamp in bytes 0-5
  ts_bytes := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex');
  result_bytes := ts_bytes || rand_bytes;

  -- byte 6: top 4 bits = version 7 (0b0111), bottom 4 = top 4 bits of us_in_ms
  byte6 := 112 | ((us_in_ms >> 6) & 15);
  result_bytes := set_byte(result_bytes, 6, byte6);

  -- byte 7: top 6 bits of byte = bottom 6 bits of us_in_ms; bottom 2 random.
  -- Ordering across same-ms calls is determined by us_in_ms here.
  byte7 := ((us_in_ms & 63) << 2) | (get_byte(result_bytes, 7) & 3);
  result_bytes := set_byte(result_bytes, 7, byte7);

  -- byte 8: top 2 bits = variant 0b10, bottom 6 = random
  result_bytes := set_byte(result_bytes, 8, (get_byte(result_bytes, 8) & 63) | 128);

  RETURN encode(result_bytes, 'hex')::uuid;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- =============================================================================
-- 2. Helper: derive the v_effective_agent_authorizations payload shape
-- =============================================================================
-- Mirrors the view's column projection so consumers see the same row
-- shape on the snapshot endpoint and on the change feed. publisher_domain
-- derivation for per-property rows uses the same regex strip as the view
-- (handles 'adagents_json:foo.example', 'community:foo.example', etc.).

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
  seq_no bigint
) RETURNS jsonb AS $$
DECLARE
  derived_publisher text;
BEGIN
  -- For per-property rows, derive publisher from catalog_properties.created_by
  -- (the writer encodes 'adagents_json:foo.example' / 'community:foo.example').
  -- Strip any pipeline prefix, matching v_effective_agent_authorizations.
  IF publisher_domain IS NULL AND property_rid IS NOT NULL THEN
    SELECT regexp_replace(cp.created_by, '^[^:]+:', '')
      INTO derived_publisher
      FROM catalog_properties cp
     WHERE cp.property_rid = caa_event_payload.property_rid;
  ELSE
    derived_publisher := publisher_domain;
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
    'override_applied',   FALSE,
    'override_reason',    NULL
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- 3. Trigger on catalog_agent_authorizations: emit granted / revoked / modified
-- =============================================================================
-- Wire format (specs/registry-authorization-model.md):
--   * granted  — visibility transition hidden → visible
--   * revoked  — visibility transition visible → hidden
--   * modified — body change without identity change
--
-- The seq_no rotation trigger (BEFORE UPDATE, defined in migration 440)
-- runs first; this trigger reads the post-rotation row.

CREATE OR REPLACE FUNCTION caa_emit_event() RETURNS trigger AS $$
DECLARE
  ev_payload jsonb;
  ev_type text;
  ev_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Tombstone-on-insert (rare; backfill replay) emits no event.
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    ev_type := 'authorization.granted';
    ev_payload := caa_event_payload(
      NEW.id, NEW.agent_url, NEW.agent_url_canonical,
      NEW.property_rid, NEW.property_id_slug, NEW.publisher_domain,
      NEW.authorized_for, NEW.evidence, NEW.disputed,
      NEW.created_by, NEW.expires_at,
      NEW.created_at, NEW.updated_at, NEW.seq_no
    );
  ELSIF TG_OP = 'UPDATE' THEN
    -- Tombstone transition (NULL → NOT NULL): revoked.
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      ev_type := 'authorization.revoked';
      ev_payload := caa_event_payload(
        OLD.id, OLD.agent_url, OLD.agent_url_canonical,
        OLD.property_rid, OLD.property_id_slug, OLD.publisher_domain,
        OLD.authorized_for, OLD.evidence, OLD.disputed,
        OLD.created_by, OLD.expires_at,
        OLD.created_at, OLD.updated_at, NEW.seq_no
      );
    -- Un-tombstone transition (NOT NULL → NULL): granted (resurrection).
    ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
      ev_type := 'authorization.granted';
      ev_payload := caa_event_payload(
        NEW.id, NEW.agent_url, NEW.agent_url_canonical,
        NEW.property_rid, NEW.property_id_slug, NEW.publisher_domain,
        NEW.authorized_for, NEW.evidence, NEW.disputed,
        NEW.created_by, NEW.expires_at,
        NEW.created_at, NEW.updated_at, NEW.seq_no
      );
    -- Body change on a live row: modified — only when an externally-
    -- visible field changed. seq_no / updated_at rotation alone does
    -- not produce an event.
    ELSIF NEW.deleted_at IS NULL
      AND (OLD.authorized_for IS DISTINCT FROM NEW.authorized_for
        OR OLD.expires_at     IS DISTINCT FROM NEW.expires_at
        OR OLD.disputed       IS DISTINCT FROM NEW.disputed) THEN
      ev_type := 'authorization.modified';
      ev_payload := caa_event_payload(
        NEW.id, NEW.agent_url, NEW.agent_url_canonical,
        NEW.property_rid, NEW.property_id_slug, NEW.publisher_domain,
        NEW.authorized_for, NEW.evidence, NEW.disputed,
        NEW.created_by, NEW.expires_at,
        NEW.created_at, NEW.updated_at, NEW.seq_no
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

CREATE TRIGGER trg_caa_emit_event
  AFTER INSERT OR UPDATE ON catalog_agent_authorizations
  FOR EACH ROW EXECUTE FUNCTION caa_emit_event();

-- =============================================================================
-- 4. Trigger on adagents_authorization_overrides: emit fan-out events
-- =============================================================================
-- Override layer is scoped to evidence='adagents_json' rows only. agent_claim
-- and community rows pass through the override layer (see view definition in
-- migration 440); this trigger filters on evidence to match.
--
-- Insert/supersede semantics:
--   * Insert active 'add' override → 1 granted event
--   * Insert active 'suppress' override → fan out N revoked events
--     (one per affected base row)
--   * Supersede active 'add' (NULL → NOT NULL superseded_at) → 1 revoked
--   * Supersede active 'suppress' → fan out N granted events
--   * Insert with superseded_at NOT NULL (historical replay) → no event

CREATE OR REPLACE FUNCTION aao_override_payload(
  ov_row adagents_authorization_overrides,
  caa_id text,
  effective_payload jsonb,
  applied boolean
) RETURNS jsonb AS $$
BEGIN
  -- Apply the override flags onto the base row's effective payload so a
  -- consumer subscribed to authorization.* events sees the same
  -- override_applied / override_reason fields as on the snapshot view.
  IF effective_payload IS NULL THEN
    -- Phantom event for an 'add' override with no base row to anchor.
    RETURN jsonb_build_object(
      'id',                 ov_row.id,
      'agent_url',          ov_row.agent_url,
      'agent_url_canonical', ov_row.agent_url_canonical,
      'property_rid',       NULL,
      'property_id_slug',   ov_row.property_id,
      'publisher_domain',   ov_row.host_domain,
      'authorized_for',     ov_row.authorized_for,
      'evidence',           'override',
      'disputed',           FALSE,
      'created_by',         ov_row.approved_by_user_id,
      'expires_at',         NULL,
      'created_at',         ov_row.created_at,
      'updated_at',         ov_row.created_at,
      'seq_no',             NULL,
      'override_applied',   applied,
      'override_reason',    ov_row.override_reason
    );
  ELSE
    RETURN effective_payload
        || jsonb_build_object('override_applied', applied,
                              'override_reason',  ov_row.override_reason);
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION aao_emit_event() RETURNS trigger AS $$
DECLARE
  base_row catalog_agent_authorizations%ROWTYPE;
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

  -- Pick OLD vs NEW depending on which one carries the (still-active)
  -- override fields we want to fan out against. For supersede,
  -- OLD has the still-active row state; for active insert, NEW does.
  IF is_supersede THEN
    ov_row := OLD;
  ELSE
    ov_row := NEW;
  END IF;

  IF ov_row.override_type = 'add' THEN
    -- 'add' overrides surface as phantom rows; one event per override,
    -- not per matched base row.
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

  -- 'suppress' overrides fan out: one event per affected base row.
  -- Active insert hides matching rows → revoked; supersede unhides → granted.
  IF is_active_insert THEN
    ev_type := 'authorization.revoked';
  ELSE
    ev_type := 'authorization.granted';
  END IF;

  FOR base_row IN
    SELECT caa.*
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
      base_row.id, base_row.agent_url, base_row.agent_url_canonical,
      base_row.property_rid, base_row.property_id_slug, base_row.publisher_domain,
      base_row.authorized_for, base_row.evidence, base_row.disputed,
      base_row.created_by, base_row.expires_at,
      base_row.created_at, base_row.updated_at, base_row.seq_no
    );
    -- 'override_applied' is TRUE on revoked (suppress is active),
    -- FALSE on granted (suppress was lifted, base is now visible again).
    ev_payload := aao_override_payload(ov_row, base_row.id::text, base_payload, is_active_insert);
    ev_id := uuidv7();
    INSERT INTO catalog_events (event_id, event_type, entity_type, entity_id, payload, actor)
    VALUES (
      ev_id, ev_type, 'authorization',
      base_row.id::text, ev_payload, 'trigger:aao_emit_event'
    );
    matched_count := matched_count + 1;
  END LOOP;

  -- A suppress override that matches zero base rows is silently a no-op
  -- (defensible — the override is recorded in adagents_authorization_overrides
  -- and will fire if a matching base row appears later via the CAA trigger).

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_aao_emit_event
  AFTER INSERT OR UPDATE ON adagents_authorization_overrides
  FOR EACH ROW EXECUTE FUNCTION aao_emit_event();
