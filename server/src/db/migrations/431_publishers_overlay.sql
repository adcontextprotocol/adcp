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
-- is the per-domain canonical record.

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
-- 2. publisher_authorization_overrides — publisher-plus / publisher-minus layer
-- =============================================================================
-- Only meaningful for publishers.source_type='adagents_json' rows: corrections
-- on top of an authoritative cached manifest. For 'community' and 'enriched'
-- rows, edits go through the publisher row itself + property_revisions
-- (migration 205) — there's no immutable cache to overlay against.

CREATE TABLE publisher_authorization_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publisher_domain TEXT NOT NULL,
  agent_url TEXT NOT NULL,
  property_id TEXT,                         -- null = applies to whole publisher; set = scoped to one property
  override_type TEXT NOT NULL               -- the WHAT
    CHECK (override_type IN ('add', 'suppress')),
  override_reason TEXT NOT NULL             -- the WHY — drives lifecycle and reconcile behavior
    CHECK (override_reason IN ('bad_actor', 'correction', 'file_broken')),
  authorized_for TEXT,                      -- scope, only meaningful for override_type='add'
  justification TEXT NOT NULL,              -- required free-text; surfaces in audit + API responses
  evidence_url TEXT,                        -- corroborating fact (ads.txt, screenshot, ticket, incident report)

  -- Approval — gated by brand-registry-moderators working group (see brand-logo-auth.ts)
  approved_by_user_id TEXT NOT NULL,
  approved_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Expiry semantics depend on override_reason:
  --   bad_actor   → typically NULL (manual lift only; clean re-crawl does not auto-supersede)
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
      'expired'                             -- expires_at passed
    )),

  UNIQUE (publisher_domain, agent_url, property_id, override_type)
);

CREATE INDEX idx_pao_publisher ON publisher_authorization_overrides(publisher_domain)
  WHERE superseded_at IS NULL;
CREATE INDEX idx_pao_agent ON publisher_authorization_overrides(agent_url)
  WHERE superseded_at IS NULL;
CREATE INDEX idx_pao_reason ON publisher_authorization_overrides(override_reason)
  WHERE superseded_at IS NULL;
CREATE INDEX idx_pao_expires ON publisher_authorization_overrides(expires_at)
  WHERE expires_at IS NOT NULL AND superseded_at IS NULL;
