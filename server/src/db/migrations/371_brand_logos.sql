-- Replace brand_logo_cache (domain, idx) with brand_logos (UUID-based identity)
-- Migrates existing data, rewrites brand_manifest URLs, creates redirect table

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create new table first (before transaction, so it exists for the migration)
CREATE TABLE brand_logos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL,
  content_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  storage_type TEXT NOT NULL DEFAULT 'inline'
    CHECK (storage_type IN ('inline', 's3')),
  storage_key TEXT,
  sha256 TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  width INTEGER,
  height INTEGER,
  source TEXT NOT NULL DEFAULT 'brandfetch'
    CHECK (source IN ('brandfetch', 'community', 'brand_owner', 'brand_json')),
  review_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (review_status IN ('pending', 'approved', 'rejected', 'deleted')),
  uploaded_by_user_id VARCHAR(255),
  uploaded_by_email VARCHAR(255),
  upload_note TEXT CHECK (length(upload_note) <= 500),
  original_filename TEXT CHECK (length(original_filename) <= 255),
  review_note TEXT CHECK (length(review_note) <= 500),
  reviewed_by_user_id VARCHAR(255),
  reviewed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_brand_logos_domain_status ON brand_logos (domain, review_status);
CREATE INDEX idx_brand_logos_tags ON brand_logos USING GIN (tags);
CREATE INDEX idx_brand_logos_pending ON brand_logos (created_at)
  WHERE review_status = 'pending';
CREATE UNIQUE INDEX idx_brand_logos_dedup ON brand_logos (domain, sha256)
  WHERE review_status IN ('pending', 'approved');

CREATE TRIGGER update_brand_logos_updated_at
  BEFORE UPDATE ON brand_logos
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Redirect table for backwards compatibility (old integer URLs -> new UUIDs)
CREATE TABLE brand_logo_redirects (
  domain TEXT NOT NULL,
  old_idx INT NOT NULL,
  new_id UUID NOT NULL REFERENCES brand_logos(id),
  PRIMARY KEY (domain, old_idx)
);

-- Migrate data from brand_logo_cache
DO $$
DECLARE
  old_count INT;
  new_count INT;
BEGIN
  -- Check if old table exists (idempotent)
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'brand_logo_cache') THEN
    RAISE NOTICE 'brand_logo_cache does not exist, skipping migration';
    RETURN;
  END IF;

  -- Step 1: Build deduped mapping of old (domain, idx) to new UUIDs
  -- DISTINCT ON (domain, sha256) avoids unique index violations when
  -- Brandfetch returns the same image at multiple positions
  CREATE TEMP TABLE logo_migration_map AS
  SELECT gen_random_uuid() AS new_id, domain, idx, sha256
  FROM (
    SELECT DISTINCT ON (domain, encode(digest(data, 'sha256'), 'hex'))
      domain, idx, encode(digest(data, 'sha256'), 'hex') AS sha256
    FROM brand_logo_cache
    ORDER BY domain, encode(digest(data, 'sha256'), 'hex'), idx ASC
  ) deduped;

  -- Also track all original (domain, idx) pairs for redirect mapping
  CREATE TEMP TABLE logo_all_indices AS
  SELECT c.domain, c.idx, encode(digest(c.data, 'sha256'), 'hex') AS sha256
  FROM brand_logo_cache c;

  -- Step 2: Insert deduplicated logos into new table
  INSERT INTO brand_logos (id, domain, content_type, data, sha256, source, review_status, created_at, updated_at)
  SELECT
    m.new_id,
    c.domain,
    c.content_type,
    c.data,
    m.sha256,
    'brandfetch',
    'approved',
    c.fetched_at,
    c.fetched_at
  FROM logo_migration_map m
  JOIN brand_logo_cache c ON c.domain = m.domain AND c.idx = m.idx;

  -- Step 3: Create redirects for ALL old indices (including duplicates)
  -- Duplicates point to the surviving UUID via sha256 join
  INSERT INTO brand_logo_redirects (domain, old_idx, new_id)
  SELECT a.domain, a.idx, m.new_id
  FROM logo_all_indices a
  JOIN logo_migration_map m ON a.domain = m.domain AND a.sha256 = m.sha256;

  -- Step 4: Validate redirect count matches original row count
  SELECT count(*) INTO old_count FROM brand_logo_cache;
  SELECT count(*) INTO new_count FROM brand_logo_redirects;
  IF old_count != new_count THEN
    RAISE EXCEPTION 'Redirect count mismatch: brand_logo_cache=%, brand_logo_redirects=%', old_count, new_count;
  END IF;

  -- Step 5: Drop old table
  DROP TABLE brand_logo_cache;

  DROP TABLE logo_all_indices;
  DROP TABLE logo_migration_map;
END $$;

-- Step 6: Backfill tags from brand_manifest and rewrite URLs to UUID-based
DO $$
DECLARE
  brand RECORD;
  logo_entry JSONB;
  new_logos JSONB;
  matched_id UUID;
  old_url TEXT;
  new_url TEXT;
  logo_tags TEXT[];
  i INT;
  base_url TEXT;
BEGIN
  base_url := coalesce(current_setting('app.base_url', true), 'https://agenticadvertising.org');

  FOR brand IN
    SELECT domain, brand_manifest
    FROM discovered_brands
    WHERE brand_manifest IS NOT NULL
      AND brand_manifest->'logos' IS NOT NULL
      AND jsonb_array_length(brand_manifest->'logos') > 0
  LOOP
    new_logos := '[]'::jsonb;
    FOR i IN 0..jsonb_array_length(brand.brand_manifest->'logos') - 1
    LOOP
      logo_entry := brand.brand_manifest->'logos'->i;
      old_url := logo_entry->>'url';

      -- Match URL pattern: /logos/brands/{domain}/{idx} or full BASE_URL variant
      SELECT r.new_id INTO matched_id
      FROM brand_logo_redirects r
      WHERE r.domain = brand.domain
        AND (old_url = '/logos/brands/' || brand.domain || '/' || r.old_idx::text
          OR old_url = base_url || '/logos/brands/' || brand.domain || '/' || r.old_idx::text);

      IF matched_id IS NOT NULL THEN
        -- Rewrite URL to UUID-based path
        new_url := '/logos/brands/' || brand.domain || '/' || matched_id::text;
        logo_entry := jsonb_set(logo_entry, '{url}', to_jsonb(new_url));

        -- Backfill tags onto brand_logos row
        IF logo_entry ? 'tags' AND jsonb_array_length(logo_entry->'tags') > 0 THEN
          SELECT ARRAY(
            SELECT jsonb_array_elements_text(logo_entry->'tags')
          ) INTO logo_tags;
          IF logo_tags IS NOT NULL AND array_length(logo_tags, 1) > 0 THEN
            UPDATE brand_logos SET tags = logo_tags
            WHERE id = matched_id;
          END IF;
        END IF;
      END IF;

      new_logos := new_logos || jsonb_build_array(logo_entry);
    END LOOP;

    UPDATE discovered_brands
    SET brand_manifest = jsonb_set(brand_manifest, '{logos}', new_logos)
    WHERE domain = brand.domain;
  END LOOP;
END $$;
