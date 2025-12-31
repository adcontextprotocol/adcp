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

-- Seed: What Addie Can Help With (default context - included in main prompt)
INSERT INTO addie_rules (rule_type, name, description, content, priority, context, created_by)
VALUES (
  'knowledge',
  'What Addie Can Help With',
  'Capabilities based on available tools and indexed knowledge',
  'Addie can help with:

SEARCH & ANSWER (via indexed docs and repos):
- AdCP protocol questions (search_docs has full protocol documentation)
- Setting up the open source salesagent (search_repos has salesagent README and docs)
- Building sales, signals, or creative agents using AdCP clients (search_repos has JS and Python client docs)
- Validating and debugging adagents.json files (validate_adagents tool)

COMMUNITY & MEMBERSHIP (via member tools):
- Joining AgenticAdvertising.org and understanding membership
- Finding and joining working groups (list_working_groups, join_working_group)
- Setting up and updating AAO member profiles (get_my_profile, update_my_profile)

RESEARCH (via search):
- Finding community discussions and Q&A (search_slack)
- Industry news and external perspectives (search_resources, web search)

Note: For MCP and A2A protocol questions, Addie can web search but does not have authoritative docs indexed.',
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
- Questions about setting up salesagent, agents, or adagents.json
- Questions about AdCP protocol, schemas, or implementation
- Questions about AgenticAdvertising.org membership or working groups
- Requests for help finding docs or examples
- Confusion needing clarification on topics Addie has tools for

Respond REACT to:
- Greetings (hi, hello, hey everyone)
- New member introductions
- Welcome messages and celebratory announcements

Respond NO to:
- Casual social conversation
- Off-topic discussions unrelated to ad tech or AAO
- Messages clearly directed at specific people
- Simple acknowledgments (ok, thanks, got it)
- Messages that already have sufficient responses
- Questions about topics Addie cannot help with',
  100,
  'engagement',
  'system'
)
ON CONFLICT DO NOTHING;
