-- Stores images and visual assets extracted from committee documents (PDFs, PPTX).
-- Enables Addie to reference brand visuals, logos, and design elements.
CREATE TABLE IF NOT EXISTS committee_document_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES committee_documents(id) ON DELETE CASCADE,
  working_group_id UUID NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,

  -- Asset metadata
  filename VARCHAR(500) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  width INTEGER,
  height INTEGER,
  file_size INTEGER,

  -- Binary data stored in Postgres (matches portrait pattern)
  asset_data BYTEA NOT NULL,

  -- AI-generated description for search indexing
  description TEXT,
  description_generated_at TIMESTAMPTZ,

  -- Source tracking
  page_number INTEGER,
  extraction_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cda_document_id ON committee_document_assets(document_id);
CREATE INDEX idx_cda_working_group_id ON committee_document_assets(working_group_id);
