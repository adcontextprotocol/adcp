-- Drop backward-compat views and INSTEAD OF triggers created by 389_merge_brand_tables.sql.
-- All application code now queries the brands table directly.

-- 1. Drop triggers (must happen before views)
DROP TRIGGER IF EXISTS hosted_brands_insert_trigger ON hosted_brands;
DROP TRIGGER IF EXISTS hosted_brands_update_trigger ON hosted_brands;
DROP TRIGGER IF EXISTS hosted_brands_delete_trigger ON hosted_brands;
DROP TRIGGER IF EXISTS discovered_brands_insert_trigger ON discovered_brands;
DROP TRIGGER IF EXISTS discovered_brands_update_trigger ON discovered_brands;
DROP TRIGGER IF EXISTS discovered_brands_delete_trigger ON discovered_brands;

-- 2. Drop views
DROP VIEW IF EXISTS hosted_brands;
DROP VIEW IF EXISTS discovered_brands;

-- 3. Drop trigger functions
DROP FUNCTION IF EXISTS hosted_brands_insert();
DROP FUNCTION IF EXISTS hosted_brands_update();
DROP FUNCTION IF EXISTS hosted_brands_delete();
DROP FUNCTION IF EXISTS discovered_brands_insert();
DROP FUNCTION IF EXISTS discovered_brands_update();
DROP FUNCTION IF EXISTS discovered_brands_delete();
