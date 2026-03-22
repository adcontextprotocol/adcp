-- Rename company.industry (string) to company.industries (string[]) in brand JSONB data.
-- Handles: string → wrap in array, null/missing → leave as-is, already array → skip.

-- hosted_brands.brand_json: string → array
UPDATE hosted_brands
SET brand_json = jsonb_set(
  brand_json #- '{company,industry}',
  '{company,industries}',
  to_jsonb(ARRAY[brand_json->'company'->>'industry'])
)
WHERE brand_json->'company'->>'industry' IS NOT NULL
  AND jsonb_typeof(brand_json->'company'->'industry') = 'string';

-- hosted_brands.brand_json: already array → rename key only
UPDATE hosted_brands
SET brand_json = jsonb_set(
  brand_json #- '{company,industry}',
  '{company,industries}',
  brand_json->'company'->'industry'
)
WHERE brand_json->'company'->'industry' IS NOT NULL
  AND jsonb_typeof(brand_json->'company'->'industry') = 'array';

-- discovered_brands.brand_manifest: string → array
UPDATE discovered_brands
SET brand_manifest = jsonb_set(
  brand_manifest #- '{company,industry}',
  '{company,industries}',
  to_jsonb(ARRAY[brand_manifest->'company'->>'industry'])
)
WHERE brand_manifest->'company'->>'industry' IS NOT NULL
  AND jsonb_typeof(brand_manifest->'company'->'industry') = 'string';

-- discovered_brands.brand_manifest: already array → rename key only
UPDATE discovered_brands
SET brand_manifest = jsonb_set(
  brand_manifest #- '{company,industry}',
  '{company,industries}',
  brand_manifest->'company'->'industry'
)
WHERE brand_manifest->'company'->'industry' IS NOT NULL
  AND jsonb_typeof(brand_manifest->'company'->'industry') = 'array';
