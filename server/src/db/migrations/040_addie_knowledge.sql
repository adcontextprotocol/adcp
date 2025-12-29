-- Migration: 037_addie_knowledge.sql
-- Addie (AAO Community Agent) knowledge base, interactions, and approval queue

-- Knowledge documents that Addie can search and reference
CREATE TABLE IF NOT EXISTS addie_knowledge (
  id SERIAL PRIMARY KEY,

  -- Document metadata
  title VARCHAR(500) NOT NULL,
  category VARCHAR(100) NOT NULL,  -- docs, blog, faq, perspective, guidelines, etc.
  source_url TEXT,                  -- Original source if applicable

  -- Content
  content TEXT NOT NULL,

  -- Search optimization
  search_vector TSVECTOR,

  -- Status
  is_active BOOLEAN DEFAULT TRUE,

  -- Audit
  created_by TEXT,                  -- WorkOS user ID or 'system'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Full-text search index
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_search ON addie_knowledge USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_category ON addie_knowledge(category);
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_active ON addie_knowledge(is_active) WHERE is_active = TRUE;

-- Trigger to update search vector on insert/update
CREATE OR REPLACE FUNCTION addie_knowledge_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.category, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'C');
  NEW.updated_at := NOW();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS addie_knowledge_search_update ON addie_knowledge;
CREATE TRIGGER addie_knowledge_search_update
  BEFORE INSERT OR UPDATE ON addie_knowledge
  FOR EACH ROW EXECUTE FUNCTION addie_knowledge_search_trigger();

-- Interaction audit log
CREATE TABLE IF NOT EXISTS addie_interactions (
  id TEXT PRIMARY KEY,              -- UUID from generateInteractionId()

  -- Event context
  event_type VARCHAR(50) NOT NULL,  -- assistant_thread, mention, dm
  channel_id VARCHAR(255) NOT NULL,
  thread_ts VARCHAR(255),
  user_id VARCHAR(255) NOT NULL,    -- Slack user ID

  -- Content
  input_text TEXT NOT NULL,
  input_sanitized TEXT NOT NULL,
  output_text TEXT NOT NULL,

  -- Tool usage
  tools_used TEXT[],
  knowledge_ids INTEGER[],          -- References to addie_knowledge.id

  -- Performance
  model VARCHAR(100) NOT NULL,
  latency_ms INTEGER NOT NULL,

  -- Security flags
  flagged BOOLEAN DEFAULT FALSE,
  flag_reason TEXT,

  -- Review status
  reviewed BOOLEAN DEFAULT FALSE,
  reviewed_by TEXT,                 -- WorkOS user ID
  reviewed_at TIMESTAMP WITH TIME ZONE,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_addie_interactions_user ON addie_interactions(user_id);
CREATE INDEX IF NOT EXISTS idx_addie_interactions_channel ON addie_interactions(channel_id);
CREATE INDEX IF NOT EXISTS idx_addie_interactions_created ON addie_interactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_addie_interactions_flagged ON addie_interactions(flagged) WHERE flagged = TRUE;
CREATE INDEX IF NOT EXISTS idx_addie_interactions_unreviewed ON addie_interactions(reviewed) WHERE reviewed = FALSE;

-- Approval queue for proactive posts (Phase 4)
CREATE TABLE IF NOT EXISTS addie_approval_queue (
  id SERIAL PRIMARY KEY,

  -- What Addie wants to do
  action_type VARCHAR(50) NOT NULL,  -- post, reply, dm, share
  target_channel_id VARCHAR(255),
  target_thread_ts VARCHAR(255),
  target_user_id VARCHAR(255),       -- For DMs

  -- Content
  proposed_content TEXT NOT NULL,

  -- Why Addie wants to do this
  trigger_type VARCHAR(100) NOT NULL, -- news_discovery, activity_summary, member_welcome, etc.
  trigger_context JSONB,              -- Additional context (e.g., source article URL)

  -- Status
  status VARCHAR(50) DEFAULT 'pending',  -- pending, approved, rejected, expired

  -- Review
  reviewed_by TEXT,                  -- WorkOS user ID
  reviewed_at TIMESTAMP WITH TIME ZONE,
  edit_notes TEXT,                   -- If admin edited before approving
  final_content TEXT,                -- Content after edits (if different)

  -- Execution
  executed_at TIMESTAMP WITH TIME ZONE,
  execution_result JSONB,            -- e.g., message ts if sent successfully

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE  -- Auto-expire old proposals
);

CREATE INDEX IF NOT EXISTS idx_addie_approval_queue_status ON addie_approval_queue(status);
CREATE INDEX IF NOT EXISTS idx_addie_approval_queue_pending ON addie_approval_queue(status, created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_addie_approval_queue_created ON addie_approval_queue(created_at DESC);

-- Comments
COMMENT ON TABLE addie_knowledge IS 'Knowledge documents that Addie can search and reference';
COMMENT ON TABLE addie_interactions IS 'Audit log of all Addie interactions with users';
COMMENT ON TABLE addie_approval_queue IS 'Queue for proactive actions that need human approval';
COMMENT ON COLUMN addie_knowledge.category IS 'Category: docs, blog, faq, perspective, guidelines, community, etc.';
COMMENT ON COLUMN addie_interactions.event_type IS 'Type: assistant_thread, mention, dm';
COMMENT ON COLUMN addie_approval_queue.status IS 'Status: pending, approved, rejected, expired';
