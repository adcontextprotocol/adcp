-- Insight Synthesis System
-- Tags valuable content from any source, synthesizes into compact rules

-- =====================================================
-- INSIGHT SOURCES
-- =====================================================
-- Content tagged as valuable for Addie's core knowledge

CREATE TABLE addie_insight_sources (
  id SERIAL PRIMARY KEY,

  -- Source identification
  source_type TEXT NOT NULL CHECK (source_type IN (
    'conversation',    -- From addie_thread_messages
    'perspective',     -- From perspectives table
    'doc',            -- From docs/ (by path)
    'slack',          -- From indexed Slack messages
    'external'        -- Pasted content (emails, articles, etc.)
  )),
  source_ref TEXT,    -- Reference to original: thread_id, perspective_id, doc path, message_id, etc.

  -- The actual content
  content TEXT NOT NULL,
  excerpt TEXT,       -- Short version for display (first ~200 chars)

  -- Categorization
  topic TEXT,         -- Grouping hint: "adoption", "platform-strategy", "trust", etc.

  -- Attribution (for context, not for Addie to cite)
  author_name TEXT,   -- Who said it: "Ben Masse"
  author_context TEXT, -- Role/expertise: "Triton Digital, audio expert"

  -- Workflow
  status TEXT DEFAULT 'pending' CHECK (status IN (
    'pending',        -- Tagged, awaiting synthesis
    'synthesized',    -- Included in a synthesis run
    'archived'        -- No longer relevant
  )),

  -- Synthesis tracking
  synthesis_run_id INTEGER,  -- FK added after synthesis_runs table created
  resulting_rule_id INTEGER REFERENCES addie_rules(id),

  -- Audit
  tagged_by TEXT NOT NULL,
  tagged_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  notes TEXT
);

CREATE INDEX idx_insight_sources_status ON addie_insight_sources(status, topic);
CREATE INDEX idx_insight_sources_topic ON addie_insight_sources(topic) WHERE topic IS NOT NULL;
CREATE INDEX idx_insight_sources_pending ON addie_insight_sources(tagged_at DESC) WHERE status = 'pending';

-- =====================================================
-- SYNTHESIS RUNS
-- =====================================================
-- Track synthesis jobs and their outputs

CREATE TABLE addie_synthesis_runs (
  id SERIAL PRIMARY KEY,

  -- Scope
  topic TEXT,                    -- NULL = all pending sources, or specific topic
  source_ids INTEGER[],          -- Which insight sources were included

  -- Input summary
  sources_count INTEGER DEFAULT 0,
  topics_included TEXT[],        -- Array of topics synthesized

  -- Output
  proposed_rules JSONB,          -- Array of {rule_type, name, content, source_ids, confidence}

  -- Preview results (replay against historical interactions)
  preview_results JSONB,         -- {predictions: [...], summary: {...}}
  preview_summary TEXT,          -- Human-readable summary

  -- Workflow
  status TEXT DEFAULT 'draft' CHECK (status IN (
    'draft',          -- Synthesis complete, awaiting review
    'approved',       -- Human approved, ready to apply
    'applied',        -- Rules created/updated
    'rejected'        -- Human rejected
  )),

  -- Application tracking
  applied_rule_ids INTEGER[],    -- Rules created from this synthesis

  -- Audit
  created_by TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  reviewed_by TEXT,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  review_notes TEXT,

  -- Cost tracking
  model_used TEXT,
  tokens_used INTEGER,
  synthesis_duration_ms INTEGER
);

CREATE INDEX idx_synthesis_runs_status ON addie_synthesis_runs(status, created_at DESC);

-- Now add FK from insight_sources to synthesis_runs
ALTER TABLE addie_insight_sources
  ADD CONSTRAINT fk_insight_sources_synthesis_run
  FOREIGN KEY (synthesis_run_id) REFERENCES addie_synthesis_runs(id);

-- =====================================================
-- HELPER VIEWS
-- =====================================================

-- Pending sources grouped by topic
CREATE VIEW addie_insight_sources_by_topic AS
SELECT
  COALESCE(topic, 'uncategorized') AS topic,
  COUNT(*) AS source_count,
  array_agg(id ORDER BY tagged_at DESC) AS source_ids,
  MIN(tagged_at) AS oldest_source,
  MAX(tagged_at) AS newest_source
FROM addie_insight_sources
WHERE status = 'pending'
GROUP BY COALESCE(topic, 'uncategorized')
ORDER BY source_count DESC;

-- Recent synthesis activity
CREATE VIEW addie_synthesis_activity AS
SELECT
  sr.id,
  sr.status,
  sr.topic,
  sr.sources_count,
  sr.topics_included,
  jsonb_array_length(sr.proposed_rules) AS rules_proposed,
  sr.preview_summary,
  sr.created_at,
  sr.reviewed_at,
  sr.reviewed_by,
  sr.model_used,
  sr.tokens_used
FROM addie_synthesis_runs sr
ORDER BY sr.created_at DESC;

-- =====================================================
-- FUNCTIONS
-- =====================================================

-- Generate excerpt from content
CREATE OR REPLACE FUNCTION generate_excerpt(content TEXT, max_length INTEGER DEFAULT 200)
RETURNS TEXT AS $$
BEGIN
  IF LENGTH(content) <= max_length THEN
    RETURN content;
  END IF;
  -- Find last space before max_length to avoid cutting words
  RETURN SUBSTRING(content FROM 1 FOR max_length - 3) || '...';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Trigger to auto-generate excerpt on insert/update
CREATE OR REPLACE FUNCTION set_insight_excerpt()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.excerpt IS NULL OR NEW.excerpt = '' THEN
    NEW.excerpt := generate_excerpt(NEW.content, 200);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_set_insight_excerpt
  BEFORE INSERT OR UPDATE ON addie_insight_sources
  FOR EACH ROW
  EXECUTE FUNCTION set_insight_excerpt();
