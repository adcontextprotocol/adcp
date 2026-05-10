---
---

Tighten the admin transfer-member flow that PR #4342 left as a known nit:

- `deleteOrganizationMembership` now accepts an optional `PoolClient` so a multi-step caller can wrap the helper's DELETE+UPDATE with a sibling write in a single transaction.
- The admin transfer-member loop in `routes/admin/accounts.ts` now wraps the source-membership delete and the target-membership insert in one transaction, closing the brief window where a parallel reader could see "user has no membership at all" between the two writes.
- Adds `invalidateMembershipCache(sourceOrgId)` + `invalidateMembershipCache(targetOrgId)` after the transaction so the in-process cache reflects the post-transfer state immediately.
- Same defensive `invalidateMembershipCache(orgId)` added to `routes/organizations.ts` admin remove-member after `deleteOrganizationMembership`.

Tests cover the external-client transaction (mid-transaction parallel reader sees pre-state, post-COMMIT sees post-state) and the rollback case (caller-side ROLLBACK rolls back the helper's writes).
