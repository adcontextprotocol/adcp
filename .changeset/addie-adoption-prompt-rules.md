---
---

Stage 1.5 of persona-driven Addie suggested prompts (#2299): add the two deferred adoption rules. Adds `adoption.has_company_listing` (derived from existing fetched profile, free) and `adoption.team_wg_coverage` (one DB query against `working_group_memberships`, reusing the WorkOS membership list already fetched) to MemberContext. Two new rules:

- **List my company in the directory** (priority 76): non-personal org with no public listing, fires for org owners and admins.
- **Find working groups for my team** (priority 73): owner/admin of a 3+ team with less than half in any working group.

API key count rule is still deferred — needs a cheaper signal source than per-request WorkOS API calls.
