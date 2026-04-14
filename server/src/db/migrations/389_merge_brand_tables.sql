-- Merge hosted_brands + discovered_brands into a single brands table.
-- discovered_brands has more columns, so we extend it and merge hosted data in.
-- Backward-compat views let existing code keep working during transition.

-- Step 1: Add hosted_brands columns and standardize timestamps on discovered_brands
ALTER TABLE discovered_brands ADD COLUMN IF NOT EXISTS workos_organization_id VARCHAR(255);
ALTER TABLE discovered_brands ADD COLUMN IF NOT EXISTS created_by_user_id VARCHAR(255);
ALTER TABLE discovered_brands ADD COLUMN IF NOT EXISTS created_by_email VARCHAR(255);
ALTER TABLE discovered_brands ADD COLUMN IF NOT EXISTS domain_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE discovered_brands ADD COLUMN IF NOT EXISTS verification_token TEXT;
ALTER TABLE discovered_brands ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT TRUE;
-- Add standard timestamp columns (discovered_brands used discovered_at/last_validated)
ALTER TABLE discovered_brands ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE discovered_brands ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
-- Backfill from existing timestamp columns
UPDATE discovered_brands
SET created_at = COALESCE(discovered_at, created_at),
    updated_at = COALESCE(last_validated, discovered_at, updated_at)
WHERE discovered_at IS NOT NULL;

-- Step 2: Merge hosted_brands data into discovered_brands
-- On conflict (same domain), hosted data takes priority for ownership/verification
INSERT INTO discovered_brands (
  domain, brand_manifest, brand_name, source_type, review_status,
  workos_organization_id, created_by_user_id, created_by_email,
  domain_verified, verification_token, is_public
)
SELECT
  h.brand_domain,
  h.brand_json,
  COALESCE(h.brand_json->>'name', h.brand_json->'house'->>'name', h.brand_domain),
  'community',
  'approved',
  h.workos_organization_id,
  h.created_by_user_id,
  h.created_by_email,
  h.domain_verified,
  h.verification_token,
  h.is_public
FROM hosted_brands h
ON CONFLICT (domain) DO UPDATE SET
  -- Preserve authoritative manifest (crawled from domain), only overwrite community/enriched
  brand_manifest = CASE
    WHEN discovered_brands.source_type = 'brand_json' THEN discovered_brands.brand_manifest
    ELSE COALESCE(EXCLUDED.brand_manifest, discovered_brands.brand_manifest)
  END,
  workos_organization_id = COALESCE(EXCLUDED.workos_organization_id, discovered_brands.workos_organization_id),
  created_by_user_id = COALESCE(EXCLUDED.created_by_user_id, discovered_brands.created_by_user_id),
  created_by_email = COALESCE(EXCLUDED.created_by_email, discovered_brands.created_by_email),
  domain_verified = COALESCE(EXCLUDED.domain_verified, discovered_brands.domain_verified),
  verification_token = COALESCE(EXCLUDED.verification_token, discovered_brands.verification_token),
  is_public = COALESCE(EXCLUDED.is_public, discovered_brands.is_public);

-- Step 3: Rename discovered_brands → brands
ALTER TABLE discovered_brands RENAME TO brands;

-- Step 4: Rename indexes (Postgres keeps old names after table rename)
ALTER INDEX IF EXISTS idx_discovered_brands_domain RENAME TO idx_brands_domain;
ALTER INDEX IF EXISTS idx_discovered_brands_canonical RENAME TO idx_brands_canonical;
ALTER INDEX IF EXISTS idx_discovered_brands_house RENAME TO idx_brands_house;
ALTER INDEX IF EXISTS idx_discovered_brands_name RENAME TO idx_brands_name;
ALTER INDEX IF EXISTS idx_discovered_brands_keller RENAME TO idx_brands_keller;
ALTER INDEX IF EXISTS idx_discovered_brands_source RENAME TO idx_brands_source;
ALTER INDEX IF EXISTS idx_discovered_brands_expires RENAME TO idx_brands_expires;

-- Add indexes for new columns
CREATE INDEX IF NOT EXISTS idx_brands_org ON brands(workos_organization_id) WHERE workos_organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_brands_public ON brands(is_public) WHERE is_public = TRUE;

-- Step 5: Update brand_revisions FK (it references domain, which is now on brands)
-- brand_revisions.domain is a text column, not a FK — no ALTER needed, just works

-- Step 6: Drop the old hosted_brands table (data already merged into brands)
DROP TABLE IF EXISTS hosted_brands;

-- Step 7: Create backward-compat views
-- These let existing code referencing the old table names keep working

CREATE OR REPLACE VIEW discovered_brands AS
SELECT * FROM brands;

CREATE OR REPLACE VIEW hosted_brands AS
SELECT
  id,
  workos_organization_id,
  created_by_user_id,
  created_by_email,
  domain AS brand_domain,
  brand_manifest AS brand_json,
  domain_verified,
  verification_token,
  is_public,
  created_at,
  updated_at
FROM brands;

-- Step 8: Make hosted_brands view writable with INSTEAD OF triggers
-- This lets all existing INSERT/UPDATE/DELETE code keep working unchanged.

CREATE OR REPLACE FUNCTION hosted_brands_insert() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO brands (domain, brand_manifest, brand_name, source_type, review_status,
    workos_organization_id, created_by_user_id, created_by_email,
    domain_verified, verification_token, is_public)
  VALUES (
    NEW.brand_domain, NEW.brand_json,
    COALESCE(NEW.brand_json->>'name', NEW.brand_json->'house'->>'name', NEW.brand_domain),
    'community', 'approved',
    NEW.workos_organization_id, NEW.created_by_user_id, NEW.created_by_email,
    COALESCE(NEW.domain_verified, FALSE), NEW.verification_token,
    COALESCE(NEW.is_public, TRUE)
  )
  ON CONFLICT (domain) DO UPDATE SET
    brand_manifest = COALESCE(EXCLUDED.brand_manifest, brands.brand_manifest),
    workos_organization_id = COALESCE(EXCLUDED.workos_organization_id, brands.workos_organization_id),
    created_by_user_id = COALESCE(EXCLUDED.created_by_user_id, brands.created_by_user_id),
    created_by_email = COALESCE(EXCLUDED.created_by_email, brands.created_by_email),
    domain_verified = COALESCE(EXCLUDED.domain_verified, brands.domain_verified),
    is_public = COALESCE(EXCLUDED.is_public, brands.is_public),
    updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hosted_brands_update() RETURNS TRIGGER AS $$
BEGIN
  UPDATE brands SET
    brand_manifest = COALESCE(NEW.brand_json, brands.brand_manifest),
    workos_organization_id = COALESCE(NEW.workos_organization_id, brands.workos_organization_id),
    domain_verified = COALESCE(NEW.domain_verified, brands.domain_verified),
    verification_token = COALESCE(NEW.verification_token, brands.verification_token),
    is_public = COALESCE(NEW.is_public, brands.is_public),
    updated_at = NOW()
  WHERE id = OLD.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hosted_brands_delete() RETURNS TRIGGER AS $$
BEGIN
  -- Don't actually delete the brand — just clear ownership fields
  UPDATE brands SET
    workos_organization_id = NULL,
    created_by_user_id = NULL,
    created_by_email = NULL,
    domain_verified = FALSE,
    verification_token = NULL
  WHERE id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hosted_brands_insert_trigger
  INSTEAD OF INSERT ON hosted_brands
  FOR EACH ROW EXECUTE FUNCTION hosted_brands_insert();

CREATE TRIGGER hosted_brands_update_trigger
  INSTEAD OF UPDATE ON hosted_brands
  FOR EACH ROW EXECUTE FUNCTION hosted_brands_update();

CREATE TRIGGER hosted_brands_delete_trigger
  INSTEAD OF DELETE ON hosted_brands
  FOR EACH ROW EXECUTE FUNCTION hosted_brands_delete();

-- Make discovered_brands view writable too (simple passthrough since it's the same table)
CREATE OR REPLACE FUNCTION discovered_brands_insert() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO brands VALUES (NEW.*) ON CONFLICT (domain) DO UPDATE SET
    brand_name = COALESCE(EXCLUDED.brand_name, brands.brand_name),
    brand_manifest = COALESCE(EXCLUDED.brand_manifest, brands.brand_manifest),
    source_type = COALESCE(EXCLUDED.source_type, brands.source_type),
    has_brand_manifest = COALESCE(EXCLUDED.has_brand_manifest, brands.has_brand_manifest),
    updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION discovered_brands_update() RETURNS TRIGGER AS $$
BEGIN
  UPDATE brands SET
    brand_name = NEW.brand_name,
    brand_manifest = NEW.brand_manifest,
    brand_names = NEW.brand_names,
    keller_type = NEW.keller_type,
    parent_brand = NEW.parent_brand,
    house_domain = NEW.house_domain,
    canonical_domain = NEW.canonical_domain,
    brand_agent_url = NEW.brand_agent_url,
    brand_agent_capabilities = NEW.brand_agent_capabilities,
    has_brand_manifest = NEW.has_brand_manifest,
    source_type = NEW.source_type,
    review_status = NEW.review_status,
    is_public = NEW.is_public,
    workos_organization_id = NEW.workos_organization_id,
    domain_verified = NEW.domain_verified,
    updated_at = NOW()
  WHERE domain = OLD.domain;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION discovered_brands_delete() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM brands WHERE domain = OLD.domain;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER discovered_brands_insert_trigger
  INSTEAD OF INSERT ON discovered_brands
  FOR EACH ROW EXECUTE FUNCTION discovered_brands_insert();

CREATE TRIGGER discovered_brands_update_trigger
  INSTEAD OF UPDATE ON discovered_brands
  FOR EACH ROW EXECUTE FUNCTION discovered_brands_update();

CREATE TRIGGER discovered_brands_delete_trigger
  INSTEAD OF DELETE ON discovered_brands
  FOR EACH ROW EXECUTE FUNCTION discovered_brands_delete();

-- Now all existing code works unchanged:
-- SELECT/INSERT/UPDATE/DELETE on hosted_brands → goes through triggers to brands
-- SELECT/INSERT/UPDATE/DELETE on discovered_brands → goes through triggers to brands
-- Direct queries on brands → works directly
