-- Add human override and publication status fields to addie_knowledge
-- Enables human curation of AI-analyzed content

ALTER TABLE addie_knowledge
  ADD COLUMN IF NOT EXISTS human_quality_override INTEGER,
  ADD COLUMN IF NOT EXISTS human_routing_override TEXT[],
  ADD COLUMN IF NOT EXISTS publication_status VARCHAR(50) DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- Index for website queries (published content by date)
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_published
  ON addie_knowledge(publication_status, published_at DESC)
  WHERE publication_status IN ('auto', 'approved', 'featured');

-- Index for routing override queries
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_human_routing
  ON addie_knowledge USING GIN(human_routing_override)
  WHERE human_routing_override IS NOT NULL;

COMMENT ON COLUMN addie_knowledge.human_quality_override IS 'Human-set quality score (1-5), overrides AI quality_score when present';
COMMENT ON COLUMN addie_knowledge.human_routing_override IS 'Human-set channel routing, overrides AI notification_channel_ids when present';
COMMENT ON COLUMN addie_knowledge.publication_status IS 'Publication state: auto (use AI decisions), approved, rejected, featured';
COMMENT ON COLUMN addie_knowledge.published_at IS 'When content was published/approved for website display';
