-- C2PA provenance signing metadata for newsletter cover images.
--
-- Mirrors migration 414 (perspective_illustrations) but on the two newsletter
-- cover stores. Covers ship in subscriber emails and as OpenGraph share cards;
-- they are the most-distributed AAO AI imagery and should carry provenance
-- from draft time rather than being reconciled by a later backfill.

ALTER TABLE weekly_digests
  ADD COLUMN IF NOT EXISTS cover_c2pa_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cover_c2pa_manifest_digest TEXT;

ALTER TABLE build_editions
  ADD COLUMN IF NOT EXISTS cover_c2pa_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cover_c2pa_manifest_digest TEXT;
