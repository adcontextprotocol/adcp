---
---

Addie can now act on org-membership diagnoses via a new `add_member_to_org` admin tool. Wraps the existing `POST /api/organizations/:orgId/members/by-email` endpoint, which handles four states automatically: invites new users, adds existing WorkOS users to the org, updates roles, or no-ops if already correct. Required args: `email`, `org_id`. Optional: `role` (default `member`), `seat_type` (default `community_only`). Closes the action half of the Pubx / Triton / Affinity Answers escalation pattern — `diagnose_signin_block` returns the verdict, `add_member_to_org` is the verb. No new endpoint, no service refactor — direct internal HTTP wrapper authenticated via `ADMIN_API_KEY`.
