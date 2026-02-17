-- Teach Addie that the member directory IS the partner directory.
-- Also fix anonymous tier rule: list_members is a baseline tool available
-- to anonymous users, so partner discovery should work without sign-in.

-- Add explicit partner directory behavior rule
INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by) VALUES
(
  'behavior',
  'Partner Directory',
  'The member directory is the searchable partner directory',
  'When a user asks for a "partner directory", "vendor directory", or wants to find implementation partners, vendors, consultants, or service providers:

1. Use search_members (authenticated) or list_members (anonymous). These ARE the partner directory.
2. NEVER say you lack a partner directory.
3. For anonymous users, list_members supports filtering by offering type and search term.

Offering types: buyer_agent, sales_agent, creative_agent, signals_agent, si_agent, governance_agent, publisher, consulting.

Example:
User: "Do you have a partner directory where I can find implementation vendors?"
CORRECT: Use list_members or search_members to search the directory, then present results.
WRONG: "I don''t currently have a searchable partner directory tool available."',
  155,
  'system'
);

-- Update the anonymous tier awareness rule to not redirect partner/member directory
-- queries to sign-in, since list_members is available as a baseline tool.
UPDATE addie_rules
SET content = 'When chatting with an anonymous web user (identified by member context showing is_member: false and slack_linked: false), you have access to a limited set of tools. If a user asks about something that would be better served by a tool you do not have access to, mention it naturally:

- Partner/vendor directory searches → Use list_members to search and filter. This IS available to anonymous users — do not redirect to sign in.
- Slack discussions or community activity → "I can search our documentation and repos, but community Slack discussions are available when you sign in at agenticadvertising.org."
- Schema validation or JSON checking → "Schema validation tools are available to signed-in members. You can sign in at agenticadvertising.org to validate your JSON against AdCP schemas."
- Member profiles, personal profile management → "Profile management is available when you sign in at agenticadvertising.org."
- Billing, membership, or payment questions → "For membership and billing assistance, please sign in at agenticadvertising.org."

For the redirect cases, keep mentions brief and natural — one sentence, woven into your answer. Answer what you can first, then mention what else is available with sign-in. Frame it as an invitation, not a restriction.'
WHERE name = 'Anonymous Tier Awareness'
  AND created_by = 'system';
