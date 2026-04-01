-- Perspective Assets
-- Binary file storage (cover images, report PDFs, attachments) for perspectives.
-- Follows the same BYTEA pattern as perspective_illustrations and committee_documents.

CREATE TABLE IF NOT EXISTS perspective_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  perspective_id UUID NOT NULL REFERENCES perspectives(id) ON DELETE CASCADE,
  asset_type VARCHAR(50) NOT NULL
    CHECK (asset_type IN ('cover_image', 'report', 'attachment')),
  file_name VARCHAR(255) NOT NULL,
  file_mime_type VARCHAR(100) NOT NULL
    CHECK (file_mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf')),
  file_data BYTEA NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  uploaded_by_user_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One cover image per perspective
CREATE UNIQUE INDEX IF NOT EXISTS idx_perspective_assets_cover
  ON perspective_assets(perspective_id) WHERE asset_type = 'cover_image';

-- Lookup by perspective + filename (for serving route)
CREATE UNIQUE INDEX IF NOT EXISTS idx_perspective_assets_filename
  ON perspective_assets(perspective_id, file_name);

-- Lookup by perspective (list all assets)
CREATE INDEX IF NOT EXISTS idx_perspective_assets_perspective
  ON perspective_assets(perspective_id);

DROP TRIGGER IF EXISTS update_perspective_assets_updated_at ON perspective_assets;
CREATE TRIGGER update_perspective_assets_updated_at
  BEFORE UPDATE ON perspective_assets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
