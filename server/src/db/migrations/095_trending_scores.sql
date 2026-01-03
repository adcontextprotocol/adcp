-- Migration: Trending scores and views
-- Add trending metrics to articles and create aggregation views

-- Add trending fields to addie_knowledge
ALTER TABLE addie_knowledge
  ADD COLUMN IF NOT EXISTS comment_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trending_score DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trending_computed_at TIMESTAMPTZ;

-- Index for trending queries (most trending first)
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_trending ON addie_knowledge(trending_score DESC)
  WHERE fetch_status = 'success' AND publication_status != 'rejected';

-- Trending entities view (for Trending Companies sidebar)
CREATE OR REPLACE VIEW trending_entities AS
SELECT
  ae.entity_type,
  ae.entity_normalized as entity_name,
  ae.organization_id,
  o.name as organization_name,
  COUNT(DISTINCT ae.knowledge_id) as article_count,
  SUM(ae.mention_count) as total_mentions,
  MAX(k.created_at) as last_mentioned_at
FROM article_entities ae
JOIN addie_knowledge k ON k.id = ae.knowledge_id
LEFT JOIN organizations o ON o.workos_organization_id = ae.organization_id
WHERE k.fetch_status = 'success'
  AND k.publication_status != 'rejected'
  AND k.created_at > NOW() - INTERVAL '7 days'
GROUP BY ae.entity_type, ae.entity_normalized, ae.organization_id, o.name
ORDER BY article_count DESC, total_mentions DESC;

-- Function to compute trending score for an article
-- Simple formula: comments + views
CREATE OR REPLACE FUNCTION compute_trending_score(
  p_comment_count INTEGER,
  p_view_count INTEGER
) RETURNS DECIMAL(10,2) AS $$
BEGIN
  RETURN COALESCE(p_comment_count, 0) + COALESCE(p_view_count, 0);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to update trending scores for all articles
CREATE OR REPLACE FUNCTION update_all_trending_scores() RETURNS INTEGER AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE addie_knowledge
  SET
    trending_score = compute_trending_score(comment_count, view_count),
    trending_computed_at = NOW()
  WHERE fetch_status = 'success'
    AND publication_status != 'rejected';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN addie_knowledge.comment_count IS 'Cached count of comments (web + Slack combined)';
COMMENT ON COLUMN addie_knowledge.view_count IS 'Number of times article has been viewed';
COMMENT ON COLUMN addie_knowledge.trending_score IS 'Trending score = comment_count + view_count';
COMMENT ON COLUMN addie_knowledge.trending_computed_at IS 'When trending score was last computed';
COMMENT ON VIEW trending_entities IS 'Aggregated entity mentions for Trending Companies sidebar (last 7 days)';
COMMENT ON FUNCTION compute_trending_score IS 'Calculates trending score: comments + views';
COMMENT ON FUNCTION update_all_trending_scores IS 'Batch update trending scores for all eligible articles';
