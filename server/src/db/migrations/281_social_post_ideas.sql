-- Track which articles have been turned into social post ideas
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS social_post_generated_at TIMESTAMPTZ;

-- Index for querying unposted high-quality articles
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_social_post_candidates
  ON addie_knowledge (quality_score DESC, created_at ASC)
  WHERE fetch_status = 'success'
    AND quality_score >= 4
    AND social_post_generated_at IS NULL;
