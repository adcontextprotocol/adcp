-- Addie Content Suggestions Migration
-- Adds support for "publish_content" suggestion type to distinguish
-- content gaps from rule changes. This enables Addie's analysis system
-- to recommend publishing new docs, perspectives, or linking to external sources.

-- First, drop the old constraint and add new one with publish_content
ALTER TABLE addie_rule_suggestions
  DROP CONSTRAINT IF EXISTS addie_rule_suggestions_suggestion_type_check;

ALTER TABLE addie_rule_suggestions
  ADD CONSTRAINT addie_rule_suggestions_suggestion_type_check
  CHECK (suggestion_type IN (
    'new_rule',        -- Propose a completely new rule
    'modify_rule',     -- Suggest changes to existing rule
    'disable_rule',    -- Recommend disabling a rule
    'merge_rules',     -- Combine multiple rules
    'experiment',      -- Propose an A/B test
    'publish_content'  -- Recommend publishing content (not a rule change)
  ));

-- Add columns for content suggestions
ALTER TABLE addie_rule_suggestions
  ADD COLUMN IF NOT EXISTS content_type TEXT CHECK (content_type IN (
    'docs',           -- Publish to protocol documentation
    'perspectives',   -- Write a perspectives article on agenticadvertising.org
    'external_link'   -- Link to existing external content
  )),
  ADD COLUMN IF NOT EXISTS suggested_topic TEXT,
  ADD COLUMN IF NOT EXISTS external_sources JSONB;  -- Array of external URLs to reference

-- Index for finding content suggestions
CREATE INDEX IF NOT EXISTS idx_addie_suggestions_content_type
  ON addie_rule_suggestions(content_type)
  WHERE content_type IS NOT NULL;
