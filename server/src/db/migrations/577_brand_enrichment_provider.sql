-- Attribute provisional brand identity to the enrichment writer without
-- constraining the registry contract to a particular vendor. Existing rows
-- remain NULL because source_type='enriched' alone does not prove who wrote
-- them; current writers populate the column on their next successful fetch.

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS enrichment_provider TEXT;

ALTER TABLE brands
  ADD CONSTRAINT brands_enrichment_provider_source_check
  CHECK (source_type = 'enriched' OR enrichment_provider IS NULL);

COMMENT ON COLUMN brands.enrichment_provider IS
  'Provider identifier for source_type=enriched; NULL when not enriched or historically unknown';
