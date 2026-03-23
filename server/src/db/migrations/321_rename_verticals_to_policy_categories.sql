-- Rename verticals → policy_categories on the policies table.
-- Maps existing industry-style values to regulatory category IDs.

ALTER TABLE policies RENAME COLUMN verticals TO policy_categories;

-- Safety check: abort if any row matches multiple category patterns
DO $$
BEGIN
  IF EXISTS (
    SELECT policy_id FROM policies
    WHERE (policy_categories @> '["political"]')::int +
          (policy_categories @> '["tobacco"]')::int +
          (policy_categories @> '["food"]')::int +
          (policy_categories @> '["cannabis"]')::int +
          (policy_categories @> '["alcohol"]')::int +
          (policy_categories @> '["gambling"]')::int +
          (policy_categories @> '["financial_services"]')::int +
          (policy_categories @> '["pharmaceutical"]')::int > 1
  ) THEN
    RAISE EXCEPTION 'Found rows matching multiple category mappings — aborting';
  END IF;
END $$;

-- Map production data from industry terms to policy category IDs (single pass)
UPDATE policies
SET policy_categories = CASE
  WHEN policy_categories @> '["political"]'::jsonb           THEN '["political_advertising"]'::jsonb
  WHEN policy_categories @> '["tobacco"]'::jsonb             THEN '["age_restricted"]'::jsonb
  WHEN policy_categories @> '["food"]'::jsonb                THEN '["health_wellness"]'::jsonb
  WHEN policy_categories @> '["cannabis"]'::jsonb            THEN '["age_restricted"]'::jsonb
  WHEN policy_categories @> '["alcohol"]'::jsonb             THEN '["age_restricted"]'::jsonb
  WHEN policy_categories @> '["gambling"]'::jsonb            THEN '["gambling_advertising"]'::jsonb
  WHEN policy_categories @> '["financial_services"]'::jsonb  THEN '["fair_lending"]'::jsonb
  WHEN policy_categories @> '["pharmaceutical"]'::jsonb      THEN '["pharmaceutical_advertising"]'::jsonb
  ELSE policy_categories
END
WHERE policy_categories IS NOT NULL
  AND policy_categories != '[]'::jsonb
  AND (
    policy_categories @> '["political"]' OR
    policy_categories @> '["tobacco"]' OR
    policy_categories @> '["food"]' OR
    policy_categories @> '["cannabis"]' OR
    policy_categories @> '["alcohol"]' OR
    policy_categories @> '["gambling"]' OR
    policy_categories @> '["financial_services"]' OR
    policy_categories @> '["pharmaceutical"]'
  );

-- Post-flight: abort if any rows still contain old industry-style values
DO $$
DECLARE
  unmapped_count int;
BEGIN
  SELECT count(*) INTO unmapped_count
  FROM policies
  WHERE policy_categories @> '["political"]'
     OR policy_categories @> '["tobacco"]'
     OR policy_categories @> '["food"]'
     OR policy_categories @> '["cannabis"]'
     OR policy_categories @> '["alcohol"]'
     OR policy_categories @> '["gambling"]'
     OR policy_categories @> '["financial_services"]'
     OR policy_categories @> '["pharmaceutical"]';
  IF unmapped_count > 0 THEN
    RAISE EXCEPTION '% rows still contain old industry-style policy_categories values', unmapped_count;
  END IF;
END $$;

-- Add GIN index for @> containment queries on policy_categories
CREATE INDEX IF NOT EXISTS idx_policies_policy_categories
  ON policies USING GIN (policy_categories);
