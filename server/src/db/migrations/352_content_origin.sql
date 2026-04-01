-- Content Origin
-- Distinguishes AAO official content from member contributions and external sources.

ALTER TABLE perspectives
  ADD COLUMN IF NOT EXISTS content_origin VARCHAR(20) NOT NULL DEFAULT 'member'
    CHECK (content_origin IN ('official', 'member', 'external'));

-- Set existing external content
UPDATE perspectives
SET content_origin = 'external'
WHERE source_type IN ('rss', 'email');

-- Set known official content
UPDATE perspectives
SET content_origin = 'official'
WHERE slug IN (
  'building-future-of-marketing',
  'adagents-json-vs-ads-txt'
);

-- Index for filtering by origin
CREATE INDEX IF NOT EXISTS idx_perspectives_content_origin
  ON perspectives(content_origin);
