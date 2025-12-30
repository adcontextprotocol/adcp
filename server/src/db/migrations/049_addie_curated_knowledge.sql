-- Migration: 049_addie_curated_knowledge.sql
-- Extend addie_knowledge for curated external content with Addie's analysis

-- Add fields for curated/fetched content
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS fetch_url TEXT;
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS last_fetched_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS fetch_status VARCHAR(50) DEFAULT 'pending';

-- Add Addie's analysis fields
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS key_insights JSONB;
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS addie_notes TEXT;
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS relevance_tags TEXT[];
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS quality_score INTEGER CHECK (quality_score >= 1 AND quality_score <= 5);

-- Track where this content came from for auto-indexing
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS discovery_source VARCHAR(100);
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS discovery_context JSONB;

-- Index for finding content that needs fetching/refreshing
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_fetch_status
  ON addie_knowledge(fetch_status)
  WHERE source_type IN ('perspective_link', 'web_search', 'curated');

CREATE INDEX IF NOT EXISTS idx_addie_knowledge_stale
  ON addie_knowledge(last_fetched_at)
  WHERE source_type IN ('perspective_link', 'web_search', 'curated')
  AND fetch_status = 'success';

-- Index for relevance tag filtering
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_relevance_tags
  ON addie_knowledge USING GIN(relevance_tags);

-- Index for quality filtering
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_quality
  ON addie_knowledge(quality_score DESC)
  WHERE quality_score IS NOT NULL;

-- Update search vector trigger to include summary in search
CREATE OR REPLACE FUNCTION addie_knowledge_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.category, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.summary, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'C');
  NEW.updated_at := NOW();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- Comments
COMMENT ON COLUMN addie_knowledge.fetch_url IS 'Original URL to fetch content from (for refresh)';
COMMENT ON COLUMN addie_knowledge.fetch_status IS 'Status: pending, fetching, success, failed';
COMMENT ON COLUMN addie_knowledge.summary IS 'Addie-generated summary of the content';
COMMENT ON COLUMN addie_knowledge.key_insights IS 'Structured key takeaways as JSON array';
COMMENT ON COLUMN addie_knowledge.addie_notes IS 'Addie contextual analysis - why this matters for AdCP';
COMMENT ON COLUMN addie_knowledge.relevance_tags IS 'Tags like: mcp, a2a, industry-trend, competitor, integration';
COMMENT ON COLUMN addie_knowledge.quality_score IS 'Quality rating 1-5 (5=authoritative, 1=low quality)';
COMMENT ON COLUMN addie_knowledge.discovery_source IS 'How found: perspective_publish, web_search, slack_link, manual';
COMMENT ON COLUMN addie_knowledge.discovery_context IS 'Context about discovery (e.g., search query, slack channel)';
