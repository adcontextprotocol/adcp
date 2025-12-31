-- Migration: 068_add_perspectives_body.sql
-- Add body column for storing raw email content from newsletter subscriptions
-- This is separate from 'content' (markdown for articles) to preserve original email HTML/text

ALTER TABLE perspectives
  ADD COLUMN IF NOT EXISTS body TEXT;

COMMENT ON COLUMN perspectives.body IS 'Raw email body content for newsletter-sourced perspectives (HTML or plain text)';

-- Add unique constraint on addie_knowledge.source_url for ON CONFLICT upserts
-- Used by createOrUpdateRssKnowledge in content-curator.ts
CREATE UNIQUE INDEX IF NOT EXISTS idx_addie_knowledge_source_url_unique
  ON addie_knowledge(source_url)
  WHERE source_url IS NOT NULL;
