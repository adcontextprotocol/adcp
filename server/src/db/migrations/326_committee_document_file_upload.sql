-- Migration: 326_committee_document_file_upload.sql
-- Allow working group leaders to upload PDF/PPTX files directly instead of requiring URLs.
-- Stores file binary data in Postgres (same pattern as portrait images).

-- Add file storage columns
ALTER TABLE committee_documents
  ADD COLUMN IF NOT EXISTS file_data BYTEA,
  ADD COLUMN IF NOT EXISTS file_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS file_mime_type VARCHAR(100);

-- Make document_url nullable for uploaded files
ALTER TABLE committee_documents
  ALTER COLUMN document_url DROP NOT NULL;

-- Fix document_type CHECK to include 'pptx' (was missing from original migration)
ALTER TABLE committee_documents
  DROP CONSTRAINT IF EXISTS committee_documents_document_type_check;

ALTER TABLE committee_documents
  ADD CONSTRAINT committee_documents_document_type_check
    CHECK (document_type IN ('google_doc', 'google_sheet', 'external_link', 'pdf', 'pptx', 'other'));

COMMENT ON COLUMN committee_documents.file_data IS 'Binary file content for directly uploaded documents (PDF, PPTX)';
COMMENT ON COLUMN committee_documents.file_name IS 'Original filename of uploaded document';
COMMENT ON COLUMN committee_documents.file_mime_type IS 'MIME type of uploaded document';
