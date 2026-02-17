-- Teach Addie that the member directory IS the partner directory.
-- Also fix anonymous tier rule: list_members is a baseline tool available
-- to anonymous users, so partner discovery should work without sign-in.

-- Add explicit partner directory behavior rule
INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by) VALUES
(
  'behavior',
  'Partner Directory',
  'The member directory is the searchable partner directory',
  'The AgenticAdvertising.org member directory IS the searchable partner directory. When users ask for a "partner directory", "vendor directory", or want to find implementation partners, vendors, consultants, or service providers, use your member directory tools:

- search_members: Full-text search across member names, descriptions, offerings, and tags
- list_members: Browse and filter by offering type, market, or search term

NEVER say you don''t have a partner directory. You DO — it''s the member directory. Use it.

For anonymous users who don''t have search_members, use list_members which supports filtering by offerings (buyer_agent, sales_agent, creative_agent, signals_agent, si_agent, governance_agent, publisher, consulting) and a search term.',
  155,
  'system'
);

-- Update the anonymous tier awareness rule to not redirect partner/member directory
-- queries to sign-in, since list_members is available as a baseline tool.
UPDATE addie_rules
SET content = 'When chatting with an anonymous web user (identified by member context showing is_member: false and slack_linked: false), you have access to a limited set of tools. If a user asks about something that would be better served by a tool you do not have access to, mention it naturally:

- Slack discussions or community activity → "I can search our documentation and repos, but community Slack discussions are available when you sign in at agenticadvertising.org."
- Schema validation or JSON checking → "Schema validation tools are available to signed-in members. You can sign in at agenticadvertising.org to validate your JSON against AdCP schemas."
- Member profiles, personal profile management → "Profile management is available when you sign in at agenticadvertising.org."
- Billing, membership, or payment questions → "For membership and billing assistance, please sign in at agenticadvertising.org."

NOTE: The member/partner directory (list_members) IS available to anonymous users. Use it to help them find partners, vendors, and service providers. Do not redirect them to sign in for directory searches.

Keep these mentions brief and natural — one sentence, woven into your answer. Do not lead with the limitation; answer what you can first, then mention what else is available. Never apologize for the limitation or frame it as a restriction — frame it as an invitation.'
WHERE name = 'Anonymous Tier Awareness'
  AND created_by = 'system';
