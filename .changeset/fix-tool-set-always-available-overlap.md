---
---

fix(addie): remove always-available tools from set arrays to prevent hallucinations

Audits every TOOL_SETS[x].tools array against ALWAYS_AVAILABLE_TOOLS and
ALWAYS_AVAILABLE_ADMIN_TOOLS, removing 9 duplicates that caused Sonnet to
hallucinate capability unavailability when a set was not routed (#2998):

- Removed propose_content, get_my_content, set_outreach_preference from member.tools
- Removed list_pending_content, approve_content, reject_content from content.tools
- Removed get_github_issue from knowledge.tools
- Removed list_escalations, resolve_escalation from admin.tools

Updated descriptions for member and content sets to not claim ownership of
always-available capabilities.

Expanded ALWAYS_AVAILABLE_BLURBS with 7 new entries (get_escalation_status,
propose_content, get_my_content, list_pending_content, approve_content,
reject_content, set_outreach_preference) so the correction section in the
unavailable-sets hint explicitly covers the reclaimed tools.

Added a tools-array invariant test that will fail if a future edit re-introduces
a duplicate, unioning both ALWAYS_AVAILABLE_TOOLS and ALWAYS_AVAILABLE_ADMIN_TOOLS.
