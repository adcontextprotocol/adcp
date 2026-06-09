-- Public brand asset promotion metadata (#5425).
--
-- The uploaded bytes already live in brand_logos and only become publicly
-- reachable after approval. These columns preserve who/what promoted the
-- asset so brand.json logo URLs can be audited back to their source flow.

ALTER TABLE brand_logos
  ADD COLUMN IF NOT EXISTS uploaded_by_org_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS source_flow TEXT,
  ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_brand_logos_uploaded_by_org
  ON brand_logos (uploaded_by_org_id)
  WHERE uploaded_by_org_id IS NOT NULL;

UPDATE brand_logos
SET
  source_flow = CASE source
    WHEN 'brandfetch' THEN 'legacy_brandfetch_import'
    WHEN 'brand_owner' THEN 'legacy_owner_upload'
    WHEN 'brand_json' THEN 'legacy_brand_json_import'
    ELSE 'legacy_community_upload'
  END,
  provenance = jsonb_build_object(
    'source_flow', CASE source
      WHEN 'brandfetch' THEN 'legacy_brandfetch_import'
      WHEN 'brand_owner' THEN 'legacy_owner_upload'
      WHEN 'brand_json' THEN 'legacy_brand_json_import'
      ELSE 'legacy_community_upload'
    END,
    'approval_path', CASE
      WHEN source = 'brand_owner' THEN 'owner_attested_legacy'
      WHEN review_status = 'approved' THEN 'approved_legacy'
      ELSE 'legacy_review_state'
    END,
    'intended_use', 'brand_json',
    'migrated_from_legacy_logo_row', true
  )
WHERE source_flow IS NULL
  AND provenance = '{}'::jsonb;
