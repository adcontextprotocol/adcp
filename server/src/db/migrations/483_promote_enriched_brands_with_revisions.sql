-- Backfill: promote enriched brands that have human curation to source_type='community'.
--
-- PR #3529 (merged 2026-05-14) gated /brands/:domain/brand.json on
-- source_type ∈ {brand_json, community} to stop serving raw Brandfetch data
-- as if it were brand-attested. But editDiscoveredBrand never bumped
-- source_type, so rows that were Brandfetch-seeded then hand-curated by AAO
-- members (e.g. scope3.com, fandom.com) stayed source_type='enriched' and
-- silently started 404'ing. editDiscoveredBrand now promotes on edit
-- (gated on real content changes, not audit-only revisions); this backfill
-- heals the rows that already drifted.
--
-- Promotion criterion: at least one revision in brand_revisions written by
-- a non-system editor. Logo-upload audit revisions are written with
-- editor_user_id='system:logo-service' or 'system:addie' and only record
-- provenance — they don't curate brand content, so they don't count as
-- community attestation. Without the system-attribution filter, this
-- migration would promote any enriched row that received a community logo
-- upload and silently start serving its Brandfetch-seeded manifest under
-- the community label.
--
-- This UPDATE is idempotent: re-running matches zero rows after the first run.

UPDATE brands b
SET source_type = 'community',
    updated_at = NOW()
WHERE b.source_type = 'enriched'
  AND EXISTS (
    SELECT 1 FROM brand_revisions br
    WHERE br.brand_domain = b.domain
      AND br.editor_user_id IS NOT NULL
      AND br.editor_user_id NOT LIKE 'system:%'
  );
