-- Migration: 221_bans.sql
-- Unified ban system replacing registry_edit_bans.
-- Supports platform-wide suspension (user/org/api_key) and
-- scoped registry edit bans (brand/property).

CREATE TABLE bans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who/what is banned
  ban_type TEXT NOT NULL CHECK (ban_type IN ('user', 'organization', 'api_key')),
  entity_id VARCHAR(255) NOT NULL,

  -- What they're banned from
  scope TEXT NOT NULL CHECK (scope IN ('platform', 'registry_brand', 'registry_property')),
  scope_target TEXT,  -- registry: specific domain, NULL = all. Ignored for platform.

  -- Audit
  banned_by_user_id VARCHAR(255) NOT NULL,
  banned_by_email VARCHAR(255),
  banned_email VARCHAR(255),  -- cached email of banned entity for display
  reason TEXT NOT NULL,

  -- Duration: NULL = permanent
  expires_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One ban per entity per scope per target
CREATE UNIQUE INDEX idx_bans_active_entity
  ON bans(ban_type, entity_id, scope, COALESCE(scope_target, '__global__'));

CREATE INDEX idx_bans_entity ON bans(entity_id);
CREATE INDEX idx_bans_type ON bans(ban_type);
CREATE INDEX idx_bans_scope ON bans(scope);

-- Migrate existing registry_edit_bans data
INSERT INTO bans (id, ban_type, entity_id, scope, scope_target,
  banned_by_user_id, banned_by_email, banned_email, reason, expires_at, created_at)
SELECT id, 'user', banned_user_id,
  CASE entity_type WHEN 'brand' THEN 'registry_brand' ELSE 'registry_property' END,
  entity_domain, banned_by_user_id, banned_by_email, banned_email, reason,
  expires_at, created_at
FROM registry_edit_bans;

DROP TABLE registry_edit_bans;
