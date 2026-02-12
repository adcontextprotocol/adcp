-- Migration: 205_registry_wiki.sql
-- Purpose: Wikipedia-model collaborative editing for brand and property registries.
-- Adds revision history, edit bans, and review status.

-- =============================================================================
-- 1. Add review_status to existing tables
-- =============================================================================

ALTER TABLE discovered_brands
  ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT 'approved'
  CHECK (review_status IN ('pending', 'approved'));

ALTER TABLE hosted_properties
  ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT 'approved'
  CHECK (review_status IN ('pending', 'approved'));

CREATE INDEX IF NOT EXISTS idx_discovered_brands_review_status
  ON discovered_brands(review_status);

CREATE INDEX IF NOT EXISTS idx_hosted_properties_review_status
  ON hosted_properties(review_status);

-- =============================================================================
-- 2. Brand revisions (append-only changelog for discovered_brands)
-- =============================================================================

CREATE TABLE brand_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which brand (natural key, not FK so revisions survive row deletion)
  brand_domain TEXT NOT NULL,

  -- Monotonically increasing per brand
  revision_number INTEGER NOT NULL,

  -- Full snapshot of the discovered_brands row at this point
  snapshot JSONB NOT NULL,

  -- Who made this edit
  editor_user_id VARCHAR(255) NOT NULL,
  editor_email VARCHAR(255),
  editor_name VARCHAR(255),

  -- What changed (required, like Wikipedia)
  edit_summary TEXT NOT NULL,

  -- Rollback metadata
  is_rollback BOOLEAN DEFAULT FALSE,
  rolled_back_to INTEGER,  -- revision_number that was restored

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(brand_domain, revision_number)
);

CREATE INDEX idx_brand_revisions_domain ON brand_revisions(brand_domain);
CREATE INDEX idx_brand_revisions_editor ON brand_revisions(editor_user_id);
CREATE INDEX idx_brand_revisions_created ON brand_revisions(created_at);

-- =============================================================================
-- 3. Property revisions (append-only changelog for hosted_properties)
-- =============================================================================

CREATE TABLE property_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  publisher_domain TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  snapshot JSONB NOT NULL,

  editor_user_id VARCHAR(255) NOT NULL,
  editor_email VARCHAR(255),
  editor_name VARCHAR(255),

  edit_summary TEXT NOT NULL,

  is_rollback BOOLEAN DEFAULT FALSE,
  rolled_back_to INTEGER,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(publisher_domain, revision_number)
);

CREATE INDEX idx_property_revisions_domain ON property_revisions(publisher_domain);
CREATE INDEX idx_property_revisions_editor ON property_revisions(editor_user_id);
CREATE INDEX idx_property_revisions_created ON property_revisions(created_at);

-- =============================================================================
-- 4. Edit bans (shared across brands and properties)
-- =============================================================================

CREATE TABLE registry_edit_bans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which registry: 'brand' or 'property'
  entity_type TEXT NOT NULL CHECK (entity_type IN ('brand', 'property')),

  -- Who is banned
  banned_user_id VARCHAR(255) NOT NULL,
  banned_email VARCHAR(255),

  -- Scope: NULL = global ban for this entity_type
  entity_domain TEXT,

  -- Who banned them and why
  banned_by_user_id VARCHAR(255) NOT NULL,
  banned_by_email VARCHAR(255),
  reason TEXT NOT NULL,

  -- Duration: NULL = permanent
  expires_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One active ban per user per entity_type per scope
CREATE UNIQUE INDEX idx_registry_edit_bans_unique
  ON registry_edit_bans(entity_type, banned_user_id, COALESCE(entity_domain, '__global__'));

CREATE INDEX idx_registry_edit_bans_user ON registry_edit_bans(banned_user_id);
CREATE INDEX idx_registry_edit_bans_domain ON registry_edit_bans(entity_domain);
CREATE INDEX idx_registry_edit_bans_type ON registry_edit_bans(entity_type);
