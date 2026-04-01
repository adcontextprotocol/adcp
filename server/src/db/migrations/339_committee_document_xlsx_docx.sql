-- Migration: 339_committee_document_xlsx_docx.sql
-- Add XLSX and DOCX as supported document types for committee documents.
-- Enables indexing of spreadsheets and Word documents uploaded to working groups.

BEGIN;

-- Expand document_type CHECK to include xlsx and docx
ALTER TABLE committee_documents
  DROP CONSTRAINT IF EXISTS committee_documents_document_type_check;

ALTER TABLE committee_documents
  ADD CONSTRAINT committee_documents_document_type_check
    CHECK (document_type IN ('google_doc', 'google_sheet', 'external_link', 'pdf', 'pptx', 'xlsx', 'docx', 'other'));

COMMIT;
