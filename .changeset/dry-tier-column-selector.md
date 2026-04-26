---
---

Close #2826: collapse the duplicated SQL + row-type pair for resolving an organization's membership tier inside a transaction. `applyAgentVisibility` (member-profiles.ts) and the seat-check path (organization-db.ts) both hand-rolled the same `SELECT membership_tier, subscription_price_lookup_key, ...` against a pg client and then fed the row into `resolveMembershipTier`. Every future tier-relevant column would have had to land in three places (resolver input type, both SELECTs) or silently degrade.

- New `MembershipTierRow` type + `MEMBERSHIP_TIER_COLUMNS` tuple in `organization-db.ts` as the single source of truth for the resolver's input shape.
- New `readMembershipTierFromClient(client, orgId, { forUpdate? })` helper that runs the SELECT with the shared column list, parses the row, and returns `MembershipTier | null`. Optional `forUpdate` for callers that need to lock the `organizations` row too.
- Both inline call sites replaced.

No behavior change. 1920 server + 631 root unit tests pass.
