-- Rename verticals → policy_categories on the policies table.
-- Maps existing industry-style values to regulatory category IDs.

ALTER TABLE policies RENAME COLUMN verticals TO policy_categories;

-- Map production data from industry terms to policy category IDs
UPDATE policies SET policy_categories = '["political_advertising"]'::jsonb
  WHERE policy_categories @> '["political"]'::jsonb;

UPDATE policies SET policy_categories = '["age_restricted"]'::jsonb
  WHERE policy_categories @> '["tobacco"]'::jsonb;

UPDATE policies SET policy_categories = '["health_wellness"]'::jsonb
  WHERE policy_categories @> '["food"]'::jsonb;

UPDATE policies SET policy_categories = '["age_restricted"]'::jsonb
  WHERE policy_categories @> '["cannabis"]'::jsonb;

UPDATE policies SET policy_categories = '["age_restricted"]'::jsonb
  WHERE policy_categories @> '["alcohol"]'::jsonb;

UPDATE policies SET policy_categories = '["gambling_advertising"]'::jsonb
  WHERE policy_categories @> '["gambling"]'::jsonb;

UPDATE policies SET policy_categories = '["fair_lending"]'::jsonb
  WHERE policy_categories @> '["financial_services"]'::jsonb;

UPDATE policies SET policy_categories = '["pharmaceutical_advertising"]'::jsonb
  WHERE policy_categories @> '["pharmaceutical"]'::jsonb;
