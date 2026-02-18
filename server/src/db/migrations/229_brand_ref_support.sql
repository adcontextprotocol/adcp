-- Add brand_id column to discovered_brands for looking up specific brands
-- within a house portfolio (e.g., brand_id="tide" under domain="pg.com").
-- For single-brand domains, brand_id is NULL.

ALTER TABLE discovered_brands ADD COLUMN IF NOT EXISTS brand_id TEXT;

CREATE INDEX IF NOT EXISTS idx_discovered_brands_brand_id
  ON discovered_brands(brand_id) WHERE brand_id IS NOT NULL;
