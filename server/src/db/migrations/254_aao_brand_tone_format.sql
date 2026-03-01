-- Update tone for AgenticAdvertising.org brands to use structured { voice, attributes } format.
-- Migration 237 seeded with ON CONFLICT DO NOTHING, so existing rows may have the old string format.
-- Split into two statements so each brand update is independent; CASE guards against a missing brand ID.

UPDATE hosted_brands
SET brand_json = (
  SELECT
    CASE WHEN pos->>'agenticadvertising' IS NOT NULL THEN
      jsonb_set(
        brand_json,
        ARRAY['brands', (pos->>'agenticadvertising')::text, 'tone'],
        '{"voice": "Professional and collaborative, championing the future of agentic advertising", "attributes": ["professional", "collaborative", "forward-thinking", "inclusive", "visionary"]}'::jsonb
      )
    ELSE brand_json
    END
  FROM (
    SELECT jsonb_object_agg(elem->>'id', (idx - 1)::text) AS pos
    FROM jsonb_array_elements(brand_json->'brands') WITH ORDINALITY AS t(elem, idx)
    WHERE elem->>'id' IN ('agenticadvertising', 'adcp')
  ) AS indices
)
WHERE brand_domain = 'agenticadvertising.org';

UPDATE hosted_brands
SET brand_json = (
  SELECT
    CASE WHEN pos->>'adcp' IS NOT NULL THEN
      jsonb_set(
        brand_json,
        ARRAY['brands', (pos->>'adcp')::text, 'tone'],
        '{"voice": "Technical and precise, empowering developers to build the next generation of advertising", "attributes": ["technical", "precise", "developer-friendly", "clear", "innovative"]}'::jsonb
      )
    ELSE brand_json
    END
  FROM (
    SELECT jsonb_object_agg(elem->>'id', (idx - 1)::text) AS pos
    FROM jsonb_array_elements(brand_json->'brands') WITH ORDINALITY AS t(elem, idx)
    WHERE elem->>'id' IN ('agenticadvertising', 'adcp')
  ) AS indices
)
WHERE brand_domain = 'agenticadvertising.org';
