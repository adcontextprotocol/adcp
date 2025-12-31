-- Migration: 067_routing_rules.sql
-- Store routing rules for display in admin UI (read-only)
--
-- Routing rules determine how Addie's router classifies incoming messages.
-- They are code-managed (not user-editable) because:
-- - Tool names must match actual registered tools
-- - Conditional logic requires code
-- - Consistency between prod/dev environments
--
-- This table is populated on server startup from router.ts and is for
-- visibility/audit purposes only. The actual routing logic lives in code.

CREATE TABLE IF NOT EXISTS addie_routing_rules (
  id SERIAL PRIMARY KEY,

  -- Rule type
  rule_type VARCHAR(50) NOT NULL, -- 'expertise', 'react', 'ignore'

  -- Rule key (unique within type)
  rule_key VARCHAR(100) NOT NULL,

  -- Human-readable description
  description TEXT NOT NULL,

  -- Match patterns (JSON array of strings)
  patterns JSONB NOT NULL DEFAULT '[]',

  -- For expertise rules: tools to use (JSON array of tool names)
  tools JSONB DEFAULT '[]',

  -- For react rules: emoji to add
  emoji VARCHAR(50),

  -- Version tracking (code version this came from)
  code_version VARCHAR(50),

  -- Timestamps
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  UNIQUE(rule_type, rule_key)
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_addie_routing_rules_type ON addie_routing_rules(rule_type);

COMMENT ON TABLE addie_routing_rules IS 'Read-only snapshot of routing rules from code, for admin visibility and audit';
COMMENT ON COLUMN addie_routing_rules.rule_type IS 'Type: expertise (respond with tools), react (emoji only), ignore';
COMMENT ON COLUMN addie_routing_rules.patterns IS 'JSON array of text patterns that trigger this rule';
COMMENT ON COLUMN addie_routing_rules.tools IS 'JSON array of tool names to use (expertise rules only)';
