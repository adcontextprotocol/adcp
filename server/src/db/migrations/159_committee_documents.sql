-- Migration: 159_committee_documents.sql
-- Tracked documents and activity summaries for committees/working groups
-- Enables monitoring Google Docs and other external documents for changes

-- =============================================================================
-- 1. Committee Documents - external documents tracked by working groups
-- =============================================================================

CREATE TABLE IF NOT EXISTS committee_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  working_group_id UUID NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,

  -- Document identification
  title VARCHAR(500) NOT NULL,
  description TEXT,  -- Brief description of what this document is for
  document_url TEXT NOT NULL,  -- Full URL (Google Docs, etc.)
  document_type VARCHAR(50) NOT NULL DEFAULT 'google_doc'
    CHECK (document_type IN ('google_doc', 'google_sheet', 'external_link', 'pdf', 'other')),

  -- Display settings
  display_order INTEGER DEFAULT 0,  -- For ordering on the page
  is_featured BOOLEAN DEFAULT FALSE,  -- Show prominently at top

  -- Content tracking (for change detection)
  content_hash VARCHAR(64),  -- SHA-256 hash of last indexed content
  last_content TEXT,  -- Cached content from last successful read
  last_indexed_at TIMESTAMPTZ,  -- When we last successfully read the content
  last_modified_at TIMESTAMPTZ,  -- When content actually changed (detected via hash)

  -- AI-generated summary of the document
  document_summary TEXT,
  summary_generated_at TIMESTAMPTZ,

  -- Access tracking
  index_status VARCHAR(50) NOT NULL DEFAULT 'pending'
    CHECK (index_status IN ('pending', 'success', 'access_denied', 'error', 'disabled')),
  index_error TEXT,  -- Error message if indexing failed

  -- Metadata
  added_by_user_id VARCHAR(255),  -- Who added this document
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_committee_documents_working_group ON committee_documents(working_group_id);
CREATE INDEX IF NOT EXISTS idx_committee_documents_status ON committee_documents(index_status);
CREATE INDEX IF NOT EXISTS idx_committee_documents_display ON committee_documents(working_group_id, display_order);
-- Composite index for the pending documents query (document_type + index_status + last_indexed_at)
CREATE INDEX IF NOT EXISTS idx_committee_documents_pending_index ON committee_documents(document_type, index_status, last_indexed_at ASC NULLS FIRST);

-- Updated at trigger
CREATE TRIGGER update_committee_documents_updated_at
  BEFORE UPDATE ON committee_documents
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE committee_documents IS 'External documents (Google Docs, etc.) tracked by committees for activity monitoring';
COMMENT ON COLUMN committee_documents.content_hash IS 'SHA-256 hash to detect content changes without storing full content twice';
COMMENT ON COLUMN committee_documents.last_content IS 'Cached content for generating summaries and detecting changes';
COMMENT ON COLUMN committee_documents.document_summary IS 'AI-generated summary of the document contents';

-- =============================================================================
-- 2. Committee Summaries - AI-generated activity summaries for working groups
-- =============================================================================

CREATE TABLE IF NOT EXISTS committee_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  working_group_id UUID NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,

  -- Summary content
  summary_type VARCHAR(50) NOT NULL DEFAULT 'activity'
    CHECK (summary_type IN ('activity', 'overview', 'changes')),
  summary_text TEXT NOT NULL,

  -- Summary metadata
  time_period_start TIMESTAMPTZ,  -- For activity summaries: what period this covers
  time_period_end TIMESTAMPTZ,

  -- What inputs were used to generate this summary
  input_sources JSONB NOT NULL DEFAULT '[]',  -- Array of {type, id, title} objects

  -- Generation tracking
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  generated_by VARCHAR(50) DEFAULT 'addie',  -- 'addie', 'manual', etc.

  -- Versioning - keep history of summaries
  is_current BOOLEAN DEFAULT TRUE,
  superseded_by UUID REFERENCES committee_summaries(id),
  superseded_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_committee_summaries_working_group ON committee_summaries(working_group_id);
CREATE INDEX IF NOT EXISTS idx_committee_summaries_current ON committee_summaries(working_group_id, is_current) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_committee_summaries_type ON committee_summaries(working_group_id, summary_type, is_current);

COMMENT ON TABLE committee_summaries IS 'AI-generated activity summaries for working groups';
COMMENT ON COLUMN committee_summaries.is_current IS 'TRUE for the latest summary of each type; superseded summaries have FALSE';
COMMENT ON COLUMN committee_summaries.input_sources IS 'JSON array tracking what documents/posts were used to generate this summary';

-- =============================================================================
-- 3. Document Activity Log - track changes over time
-- =============================================================================

CREATE TABLE IF NOT EXISTS committee_document_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES committee_documents(id) ON DELETE CASCADE,
  working_group_id UUID NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,

  -- What happened
  activity_type VARCHAR(50) NOT NULL
    CHECK (activity_type IN ('indexed', 'content_changed', 'access_lost', 'access_restored', 'error')),

  -- Details about the change
  content_hash_before VARCHAR(64),
  content_hash_after VARCHAR(64),
  change_summary TEXT,  -- AI-generated description of what changed

  -- Tracking
  detected_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_document_activity_document ON committee_document_activity(document_id);
CREATE INDEX IF NOT EXISTS idx_document_activity_working_group ON committee_document_activity(working_group_id, detected_at DESC);

COMMENT ON TABLE committee_document_activity IS 'Log of document changes for activity feeds and auditing';

-- =============================================================================
-- Done
-- =============================================================================
