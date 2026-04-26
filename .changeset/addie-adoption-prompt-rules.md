---
---

Stage 1.5 of persona-driven Addie suggested prompts (#2299): add the two deferred adoption rules. Adds `adoption.has_company_listing` (derived from existing fetched profile, free) and `adoption.team_wg_coverage` (one DB query against `working_group_memberships`, reusing the WorkOS membership list already fetched) to MemberContext. Two new rules: "Set up your company listing" for non-personal owners without a public listing (priority 76), and "Get your team into working groups" for owners of 5+ teams with <30% WG coverage (priority 73). API key count rule is still deferred — needs a cheaper signal source than per-request WorkOS API calls.
