-- Property registry overlay schema.
-- Mirrors the brand registry pattern (migration 389): cache the source-of-truth
-- adagents.json file body, plus a narrow override layer for cases where the
-- publisher's file is wrong, missing a fact, or being used by a bad actor.
--
-- This migration only creates the empty schema. The crawler does not write
-- to these tables yet — that lands in a later PR. Existing readers continue
-- using discovered_properties / agent_property_authorizations unchanged.

-- =============================================================================
-- 1. publishers — one row per publisher domain, caches adagents.json manifest
-- =============================================================================
-- NOT to be confused with discovered_publishers (migration 025), which records
-- "agent X claims to know about domain Y" as a many-to-many edge. This table
-- is the per-domain canonical record for publisher-hosted adagents.json files.
--
-- Note on scope: adagents.json is also hosted at data-provider domains for
-- signal authorization. v1 covers publisher-hosted files only; signal-provider
-- caching is a future extension (separate table or host_type discriminator).
--
-- Note on JSONB trust: adagents_json is attacker-controlled (publisher
-- publishes whatever they want). Downstream consumers must not pass it to
-- jsonb_path_query with user-supplied paths, eval it, or splat into LLM
-- prompts without fencing.

CREATE TABLE publishers (
  domain TEXT PRIMARY KEY,
  adagents_json JSONB,                      -- cached file body; null until first successful crawl
  source_type TEXT NOT NULL                 -- mirrors brand registry vocabulary
    CHECK (source_type IN ('adagents_json', 'community', 'enriched')),
  domain_verified BOOLEAN NOT NULL DEFAULT FALSE,
  last_validated TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  workos_organization_id TEXT,
  created_by_user_id TEXT,
  created_by_email TEXT,
  review_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (review_status IN ('pending', 'approved')),
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_publishers_source_type ON publishers(source_type);
CREATE INDEX idx_publishers_review_status ON publishers(review_status);
CREATE INDEX idx_publishers_org ON publishers(workos_organization_id)
  WHERE workos_organization_id IS NOT NULL;
CREATE INDEX idx_publishers_expires ON publishers(expires_at)
  WHERE expires_at IS NOT NULL;

-- =============================================================================
-- 2. adagents_authorization_overrides — publisher-plus / publisher-minus layer
-- =============================================================================
-- Only meaningful for publishers.source_type='adagents_json' rows: corrections
-- on top of an authoritative cached manifest. For 'community' and 'enriched'
-- rows, edits go through the publisher row itself + property_revisions
-- (migration 205) — there's no immutable cache to overlay against.
--
-- Naming: the table is named for the file it overrides (adagents.json), not
-- for the host type (publisher), so the schema can carry signal-provider
-- overrides in the future without a rename. host_domain is the adagents.json
-- host (publisher today; data-provider domain when signals lands).
--
-- Scope (v1): override applies either to a whole host (property_id IS NULL)
-- or to a single named property_id. Richer scoping (property_tags,
-- placement_ids, placement_tags, countries, signal_ids) is deferred — when
-- real demand emerges, ALTER to add scope JSONB. Bad-actor blocks (the
-- dominant override case) are host-wide, so v1 covers the load-bearing path.
--
-- Field-level corrections (delegation_type, exclusive, signing_keys,
-- effective_from/until) are not representable in v1. Overrides are agent-level
-- add/suppress only. Field-level corrections require full suppress + re-issue.

CREATE TABLE adagents_authorization_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_domain TEXT NOT NULL,                -- the adagents.json host (publisher in v1)

  -- agent_url is the raw declared value; agent_url_canonical is what UNIQUE
  -- and indexes use. Writer applies AdCP URL canonicalization rules
  -- (docs/reference/url-canonicalization). The schema-level CHECK enforces
  -- the foundational invariants (lowercase, no trailing slash) so two
  -- writers cannot disagree about whether https://Foo.com/ and
  -- https://foo.com refer to the same agent.
  agent_url TEXT NOT NULL,
  agent_url_canonical TEXT NOT NULL,

  property_id TEXT,                         -- null = applies to whole host; set = scoped to one property_id
  override_type TEXT NOT NULL               -- the WHAT
    CHECK (override_type IN ('add', 'suppress')),
  override_reason TEXT NOT NULL             -- the WHY — drives lifecycle and reconcile behavior
    CHECK (override_reason IN ('bad_actor', 'correction', 'file_broken')),
  authorized_for TEXT,                      -- scope description, only meaningful for override_type='add'
  justification TEXT NOT NULL,              -- required free-text; surfaces in audit + API responses
  evidence_url TEXT,                        -- corroborating fact (ads.txt, screenshot, ticket, incident report)

  -- Approval — gated by brand-registry-moderators working group (see brand-logo-auth.ts)
  approved_by_user_id TEXT NOT NULL,
  approved_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Expiry semantics depend on override_reason — enforced by CHECK below:
  --   bad_actor   → must be NULL (manual lift only; clean re-crawl does not auto-supersede)
  --   correction  → typically last_validated + 90 days (auto-superseded when publisher fixes file)
  --   file_broken → typically NULL (lifted when adagents.json parses cleanly again)
  expires_at TIMESTAMPTZ,

  -- Supersession audit
  superseded_at TIMESTAMPTZ,
  superseded_by_user_id TEXT,               -- approver user_id, or 'system:reconcile' for auto-supersede
  superseded_reason TEXT
    CHECK (superseded_reason IN (
      'publisher_corrected',                -- crawler saw publisher's file come into agreement (correction only)
      'file_reparseable',                   -- adagents.json parses again (file_broken only)
      'manual_lift',                        -- approver explicitly lifted
      'expired'                             -- expires_at passed (correction only)
    )),

  -- Schema invariants — push design rules into the database so a buggy
  -- writer or compromised moderator cannot silently un-ban a bad actor.

  -- Foundational URL canonicalization invariant: full canonicalization is
  -- applied by the writer; schema enforces lowercase + no trailing slash so
  -- two writers cannot diverge on the simplest cases.
  CONSTRAINT chk_aao_agent_url_canonical
    CHECK (agent_url_canonical = lower(agent_url_canonical)
       AND agent_url_canonical NOT LIKE '%/'),

  -- bad_actor overrides cannot have an expiry. Auto-expiry would silently
  -- re-authorize a banned agent. Lift is manual-only.
  CONSTRAINT chk_aao_bad_actor_no_expiry
    CHECK (override_reason <> 'bad_actor' OR expires_at IS NULL),

  -- Reconcile job cannot auto-supersede a bad_actor row with
  -- 'publisher_corrected' (clean re-crawl ≠ exoneration). Each reason has
  -- a constrained set of allowed supersession paths.
  CONSTRAINT chk_aao_supersede_reason
    CHECK (
      superseded_reason IS NULL OR
      (override_reason = 'bad_actor' AND superseded_reason = 'manual_lift') OR
      (override_reason = 'correction' AND superseded_reason IN ('publisher_corrected', 'manual_lift', 'expired')) OR
      (override_reason = 'file_broken' AND superseded_reason IN ('file_reparseable', 'manual_lift'))
    ),

  -- superseded_* columns must be set together
  CONSTRAINT chk_aao_supersede_consistency
    CHECK (
      (superseded_at IS NULL AND superseded_by_user_id IS NULL AND superseded_reason IS NULL)
      OR
      (superseded_at IS NOT NULL AND superseded_by_user_id IS NOT NULL AND superseded_reason IS NOT NULL)
    )
);

-- Active-set uniqueness as a partial unique index. Superseded rows accumulate
-- without conflict (preserves audit trail). COALESCE handles the NULL
-- property_id case (Postgres treats NULLs as distinct in plain UNIQUE).
CREATE UNIQUE INDEX idx_aao_unique_active
  ON adagents_authorization_overrides
  (host_domain, agent_url_canonical, COALESCE(property_id, ''), override_type)
  WHERE superseded_at IS NULL;

CREATE INDEX idx_aao_host ON adagents_authorization_overrides(host_domain)
  WHERE superseded_at IS NULL;
CREATE INDEX idx_aao_agent ON adagents_authorization_overrides(agent_url_canonical)
  WHERE superseded_at IS NULL;
CREATE INDEX idx_aao_reason ON adagents_authorization_overrides(override_reason)
  WHERE superseded_at IS NULL;
CREATE INDEX idx_aao_expires ON adagents_authorization_overrides(expires_at)
  WHERE expires_at IS NOT NULL AND superseded_at IS NULL;
CREATE INDEX idx_aao_created ON adagents_authorization_overrides(created_at);
