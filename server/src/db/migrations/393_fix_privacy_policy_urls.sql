-- +goose Up
-- Fix privacy_policy_url in AAO hosted brand manifests to use canonical /legal/privacy path

UPDATE brands
SET brand_manifest = jsonb_set(
  brand_manifest,
  '{sub_brands}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN sub_brand->>'privacy_policy_url' = 'https://agenticadvertising.org/privacy'
          THEN jsonb_set(sub_brand, '{privacy_policy_url}', '"https://agenticadvertising.org/legal/privacy"')
        WHEN sub_brand->>'privacy_policy_url' = 'https://adcontextprotocol.org/privacy'
          THEN jsonb_set(sub_brand, '{privacy_policy_url}', '"https://adcontextprotocol.org/legal/privacy"')
        ELSE sub_brand
      END
    )
    FROM jsonb_array_elements(brand_manifest->'sub_brands') AS sub_brand
  )
)
WHERE domain = 'agenticadvertising.org'
  AND brand_manifest->'sub_brands' IS NOT NULL;

-- +goose Down
UPDATE brands
SET brand_manifest = jsonb_set(
  brand_manifest,
  '{sub_brands}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN sub_brand->>'privacy_policy_url' = 'https://agenticadvertising.org/legal/privacy'
          THEN jsonb_set(sub_brand, '{privacy_policy_url}', '"https://agenticadvertising.org/privacy"')
        WHEN sub_brand->>'privacy_policy_url' = 'https://adcontextprotocol.org/legal/privacy'
          THEN jsonb_set(sub_brand, '{privacy_policy_url}', '"https://adcontextprotocol.org/privacy"')
        ELSE sub_brand
      END
    )
    FROM jsonb_array_elements(brand_manifest->'sub_brands') AS sub_brand
  )
)
WHERE domain = 'agenticadvertising.org'
  AND brand_manifest->'sub_brands' IS NOT NULL;
