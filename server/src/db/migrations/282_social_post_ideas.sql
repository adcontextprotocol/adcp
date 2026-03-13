-- Track which articles have been turned into social post ideas
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS social_post_generated_at TIMESTAMPTZ;

-- Partial index for candidate selection query.
-- The filtered set is small (quality >= 4, unposted), so the sort columns
-- match getBestUnpostedArticle's ORDER BY for index-only sorting.
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_social_post_candidates
  ON addie_knowledge (mentions_adcp DESC, mentions_agentic DESC, quality_score DESC, created_at DESC)
  WHERE fetch_status = 'success'
    AND quality_score >= 4
    AND social_post_generated_at IS NULL;
