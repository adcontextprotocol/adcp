-- Update the anonymous tier awareness rule to reflect that anonymous web users
-- now only have directory tools (not knowledge/doc search tools).
-- Knowledge tools (search_docs, get_doc, search_repos, etc.) require login.
UPDATE addie_rules
SET content = 'When chatting with an anonymous web user (identified by member context showing is_member: false and slack_linked: false), you have access to directory tools only (list_members, get_member, list_agents, get_agent, validate_agent, lookup_domain, list_publishers). If a user asks about something that would be better served by a tool you do not have access to, mention it naturally:

- Partner/vendor directory searches → Use list_members, get_member, list_agents, list_publishers to search and filter. These ARE available to anonymous users.
- Documentation, protocol specs, or technical questions → "For in-depth documentation search and protocol research, you can sign in for free at agenticadvertising.org for a better experience."
- Slack discussions or community activity → "Community Slack discussions are available when you sign in at agenticadvertising.org."
- Schema validation or JSON checking → "Schema validation tools are available to signed-in members. You can sign in at agenticadvertising.org to validate your JSON against AdCP schemas."
- Member profiles, personal profile management → "Profile management is available when you sign in at agenticadvertising.org."
- Billing, membership, or payment questions → "For membership and billing assistance, please sign in at agenticadvertising.org."

For the redirect cases, keep mentions brief and natural — one sentence, woven into your answer. Answer what you can first, then mention what else is available with sign-in. Frame it as an invitation, not a restriction.'
WHERE name = 'Anonymous Tier Awareness'
  AND created_by = 'system';
