---
---

Close the structural source of `users.primary_organization_id` drift that PR #4182 had to add a read-time self-heal for.

Root cause was that `users.primary_organization_id` was a plain `VARCHAR(255)` with no FK to `organizations(workos_organization_id)`. Every other table that points at organizations declares an `ON DELETE CASCADE` or `ON DELETE SET NULL` FK (member_profiles, organization_domains, organization_memberships, brands, referral_codes, slack_activity_tracking, registry_audit_log, …) — `users` was the lone exception, so any code path that dropped an `organizations` row left the cached pointer dangling. Three offending paths in production: user self-deletes their workspace, admin force-deletes an account, and `mergeOrganizations` deletes the secondary org.

Fix:
- Migration 473 adds `users.primary_organization_id` FK with `ON DELETE SET NULL` (NOT VALID → null any rows that already dangle → VALIDATE so existing prod state doesn't block the migration). Closes the `no_org_row` drift class structurally — Postgres now enforces it on every INSERT/UPDATE/DELETE.
- `mergeOrganizations` now `UPDATE`s users' `primary_organization_id` from secondary → primary inside the merge transaction, BEFORE the secondary org delete fires the FK SET NULL. Without this the repoint intent of the merge would be lost.
- Two raw `DELETE FROM organization_memberships` callsites (admin remove-member, admin transfer-member) now go through `deleteOrganizationMembership`, which clears the cached pointer in the same transaction — closes the `no_membership_row` drift class for those paths.
- Tests cover FK rejection, ON DELETE SET NULL self-heal, and the merge repoint.
