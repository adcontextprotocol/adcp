-- Migration: 066_rule_contexts.sql
-- Add context field to rules for contextual rule application
--
-- Rules can now be tagged with a context that determines when they're applied:
-- - NULL or 'default': Always included in main system prompt
-- - 'engagement': Only used for "should I respond?" evaluation in channels
-- - 'admin': Only included when talking to admin users
-- - 'member': Only included when talking to organization members
-- - 'anonymous': Only included when talking to anonymous/unlinked users

ALTER TABLE addie_rules ADD COLUMN IF NOT EXISTS context VARCHAR(50) DEFAULT NULL;

-- Add index for filtering by context
CREATE INDEX IF NOT EXISTS idx_addie_rules_context ON addie_rules(context);

-- Add comment
COMMENT ON COLUMN addie_rules.context IS 'Context where this rule applies: NULL/default=main prompt, engagement=should-respond check, admin/member/anonymous=user type specific';

-- Migrate existing engagement rules to use context
UPDATE addie_rules SET context = 'engagement' WHERE rule_type = 'engagement';

-- Seed: Areas of Expertise (default context - included in main prompt)
INSERT INTO addie_rules (rule_type, name, description, content, priority, context, created_by)
VALUES (
  'knowledge',
  'Areas of Expertise',
  'Topics Addie is knowledgeable about and should engage with',
  'Addie is an expert in:
- AdCP (Ad Context Protocol) - the open standard for AI-powered advertising
- Agentic advertising - using AI agents for media buying and campaign management
- AgenticAdvertising.org - the member organization, working groups, and community
- MCP (Model Context Protocol) - the underlying protocol AdCP builds on
- Ad tech fundamentals - DSPs, SSPs, RTB, programmatic advertising
- Creative formats and specifications
- Campaign measurement and attribution',
  100,
  NULL,
  'system'
)
ON CONFLICT DO NOTHING;

-- Seed: Channel Engagement Rules (engagement context - for should-respond evaluation)
INSERT INTO addie_rules (rule_type, name, description, content, priority, context, created_by)
VALUES (
  'behavior',
  'Channel Engagement',
  'When to respond, react, or ignore messages in Slack channels',
  'Respond YES to:
- Questions about AdCP, MCP, or agentic advertising
- Questions about AgenticAdvertising.org membership or working groups
- Requests for help with ad tech implementation
- Confusion or requests for clarification on topics you know

Respond REACT to:
- Greetings (hi, hello, hey everyone)
- New member introductions
- Welcome messages
- Celebratory announcements

Respond NO to:
- Casual social conversation
- Off-topic discussions
- Messages clearly directed at specific people
- Simple acknowledgments (ok, thanks, got it)
- Messages that already have sufficient responses',
  100,
  'engagement',
  'system'
)
ON CONFLICT DO NOTHING;
