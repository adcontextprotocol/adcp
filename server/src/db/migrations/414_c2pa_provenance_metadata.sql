-- C2PA provenance signing metadata for AAO-generated imagery.
--
-- c2pa_signed_at is NULL for rows that have not yet been signed (either predate
-- signing or failed to sign and are pending backfill). The manifest digest is
-- the SHA-256 of the embedded C2PA manifest bytes, useful for admin tooling
-- and for detecting tampering without re-parsing the PNG.

ALTER TABLE member_portraits
  ADD COLUMN IF NOT EXISTS c2pa_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS c2pa_manifest_digest TEXT;

ALTER TABLE perspective_illustrations
  ADD COLUMN IF NOT EXISTS c2pa_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS c2pa_manifest_digest TEXT;

CREATE INDEX IF NOT EXISTS idx_member_portraits_c2pa_unsigned
  ON member_portraits(created_at)
  WHERE c2pa_signed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_perspective_illustrations_c2pa_unsigned
  ON perspective_illustrations(created_at)
  WHERE c2pa_signed_at IS NULL;
