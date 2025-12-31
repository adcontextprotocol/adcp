-- Migration: 066_addie_capabilities_rule.sql
-- Seed rule describing what Addie can help with based on available tools

-- Seed: What Addie Can Help With (included in main system prompt)
INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by)
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
  'system'
)
ON CONFLICT DO NOTHING;
