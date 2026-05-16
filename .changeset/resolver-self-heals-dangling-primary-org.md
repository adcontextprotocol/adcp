---
---

Stop returning a phantom orgId when `users.primary_organization_id` points at an org with no row in `organizations` (or no current `organization_memberships` row for that user). Every tier-gated read site that runs `getOrganization()` after `resolvePrimaryOrganization()` would 404 with "Organization not found" — Warren at media.net hit this when flipping an agent to public; 14 other users had the same dangling cache state.

Fix:
- `resolvePrimaryOrganization()` cache read now uses an `EXISTS`-checked SELECT that returns the cached pointer plus a `joins_valid` boolean. Only trusts the cache when both `organizations` and `organization_memberships` joins still hold.
- When the cache dangles and a real membership exists, repoints the column unconditionally (the existing `backfillPrimaryOrganization` is IS-NULL-guarded by design — used by webhooks where overwriting would be wrong).
- When the cache dangles and no replacement exists, NULLs the column so a future membership webhook can re-trigger the IS-NULL backfill.
- Adds `server/src/scripts/repair-dangling-primary-orgs.ts` (default dry-run) to clear the existing backlog in one shot rather than waiting for each user to round-trip an authenticated page.
