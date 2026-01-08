-- Backfill published_at in addie_knowledge from perspectives table
-- This ensures RSS articles sort by their original publication date

UPDATE addie_knowledge k
SET published_at = p.published_at
FROM perspectives p
WHERE k.source_url = p.external_url
  AND k.published_at IS NULL
  AND p.published_at IS NOT NULL;

-- Deduplicate entries that might have been created with different URLs
-- (e.g., with/without tracking params, www vs non-www) but same content.
-- We keep the entry with the most recent updated_at (most complete analysis).
--
-- Note: This is a one-time cleanup migration. The normalization logic here
-- approximates the TypeScript normalizeUrl() function. Going forward, URLs
-- are normalized before storage to prevent duplicates from being created.

WITH normalized AS (
  SELECT
    id,
    source_url,
    updated_at,
    -- Normalize: lowercase hostname, remove www, strip query params and trailing slash
    -- This approximates the TypeScript normalizeUrl() function
    lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(source_url, '\?.*$', ''),  -- Remove query params
          '/$', ''                                   -- Remove trailing slash
        ),
        '^(https?://)www\.', '\1'                   -- Remove www prefix
      )
    ) as normalized_url
  FROM addie_knowledge
  WHERE source_url IS NOT NULL
    AND source_type = 'rss'
),
-- For each normalized URL group, find duplicates (keeping the most recently updated)
duplicates AS (
  SELECT n1.id
  FROM normalized n1
  WHERE EXISTS (
    SELECT 1 FROM normalized n2
    WHERE n2.normalized_url = n1.normalized_url
      AND n2.id != n1.id
      AND (n2.updated_at > n1.updated_at OR (n2.updated_at = n1.updated_at AND n2.id < n1.id))
  )
)
DELETE FROM addie_knowledge
WHERE id IN (SELECT id FROM duplicates);
