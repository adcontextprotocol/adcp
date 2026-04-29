-- Backfill legacy out-of-enum `type` values inside member_profiles.agents JSONB.
--
-- Pre-existing rows can carry `type: 'buyer'` or `type: 'seller'` from older
-- dev seeds and possibly from API callers that predate the AgentType enum
-- being enforced. After PR #3498's tightening:
--   - AgentConfig.type is `AgentType` (no legacy `'buyer'` slot)
--   - normalizeAgentConfig drops invalid values on every JSONB read
-- Reads return `type: undefined` for those rows. This migration normalises
-- them in-place so the registry reflects the user's intent rather than
-- silently dropping the field.
--
-- Mapping is the same as the dev-setup seed corrections in PR #3498:
--   'buyer'  -> 'buying'  (buy-side agent)
--   'seller' -> 'sales'   (sell-side agent)

UPDATE member_profiles mp
SET agents = (
  SELECT jsonb_agg(
    CASE
      WHEN elem->>'type' = 'buyer'  THEN jsonb_set(elem, '{type}', '"buying"')
      WHEN elem->>'type' = 'seller' THEN jsonb_set(elem, '{type}', '"sales"')
      ELSE elem
    END
  )
  FROM jsonb_array_elements(mp.agents) elem
)
WHERE mp.agents IS NOT NULL
  AND mp.agents != '[]'::jsonb
  AND (mp.agents::text LIKE '%"buyer"%' OR mp.agents::text LIKE '%"seller"%');
