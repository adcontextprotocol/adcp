-- Fix Moltbook integration to use addie_knowledge table
-- The original migration incorrectly referenced perspectives table
-- for columns that only exist on addie_knowledge

-- Add knowledge_id column to track which addie_knowledge items have been posted
ALTER TABLE moltbook_posts
  ADD COLUMN IF NOT EXISTS knowledge_id INTEGER REFERENCES addie_knowledge(id);

-- Create index for deduplication check
CREATE INDEX IF NOT EXISTS idx_moltbook_posts_knowledge ON moltbook_posts(knowledge_id);
