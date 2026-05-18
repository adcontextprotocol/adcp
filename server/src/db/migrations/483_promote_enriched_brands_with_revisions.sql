-- Backfill: promote enriched brands that have human edits to source_type='community'.
--
-- PR #3529 (merged 2026-05-14) gated /brands/:domain/brand.json on
-- source_type ∈ {brand_json, community} to stop serving raw Brandfetch data
-- as if it were brand-attested. But editDiscoveredBrand never bumped
-- source_type, so rows that were Brandfetch-seeded then hand-curated by AAO
-- members (e.g. scope3.com, fandom.com) stayed source_type='enriched' and
-- silently started 404ing. editDiscoveredBrand now promotes on edit; this
-- backfill heals the rows that already drifted.
--
-- Promotion criterion: at least one row in brand_revisions for the domain.
-- A revision = a human edit went through the audited path, which is the
-- definition of community attestation. Brandfetch-only rows with no human
-- touch stay enriched and stay 404 (correct per #3529).

UPDATE brands b
SET source_type = 'community',
    updated_at = NOW()
WHERE b.source_type = 'enriched'
  AND EXISTS (
    SELECT 1 FROM brand_revisions br WHERE br.brand_domain = b.domain
  );
