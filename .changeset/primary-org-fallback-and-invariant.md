---
---

Fix paid members being silently treated as non-members when `users.primary_organization_id` is NULL.

The column is a denormalized pointer set by the `organization_membership.created` webhook and by `enrichUserWithMembership` on page load. A user.created vs membership.created webhook-order race or a fire-and-forget backfill failure can leave it NULL even when the user has memberships. Eleven read sites (Addie member tools, brand-feeds, referrals, brand-claim, registry-api, resolve-caller-org, member-profile, community sync) treated NULL as "no organization" — that's how a paid Founding member at ResponsiveAds saw "no directory listing" and "not a member" despite an active subscription.

Fix:
- New `resolvePrimaryOrganization()` helper in `users-db.ts` that does the read-with-fallback (column → organization_memberships → opportunistic backfill). All 11 direct reads now go through it.
- `upsertUser` webhook handler now backfills the column after creating/updating the users row, closing the race where membership.created arrives first.
- One-time migration backfills any existing NULL rows from organization_memberships.
- New `users-have-primary-organization` integrity invariant catches new drift; visible at `/api/admin/integrity/check`.
