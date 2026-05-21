---
---

fix(aao): WorkOS-first auto-promote + role drift reconciliation

When a webhook-driven membership upsert promoted a user to `owner` because the org had no other admin/owner, the SQL wrote `role='owner'` locally first and then tried to mirror the change back to WorkOS. A best-effort rollback existed for the WorkOS-update failure case, but if both the WorkOS push *and* the rollback failed (transient API errors, mid-flight process restart, partial outage), the row sat with `local=owner, WorkOS=member` indefinitely. AAO admin reads local, so the admin UI showed "Owner"; every other surface (Linked Domains, member-profile gates, `resolveUserOrgMembership`) reads WorkOS and treated the user as `member`. At least one prod org drifted this way for months.

Three changes:

1. `upsertOrganizationMembership` is now a dumb mirror — it writes whatever role the caller hands it, no CASE/NOT-EXISTS auto-promote inside the SQL. The auto-promote moves up into the webhook handler as `resolveRoleWithWorkosFirstPromote`, which lists WorkOS memberships, calls `updateOrganizationMembership` on WorkOS *first*, and only then asks the local upsert to write the resolved role. If the WorkOS list or update fails, the caller falls back to `member` locally — local can no longer get ahead of WorkOS.
2. Both outcomes of the auto-promote write a row to `registry_audit_log` (`membership_auto_promoted_to_owner` on success, `membership_auto_promote_failed` on failure). The next "how did this user become owner?" investigation no longer requires log surgery.
3. `POST /api/admin/organizations/:orgId/add-users` (Domain Health "move users from personal workspaces") used to insert a local-only `organization_memberships` row with no `createOrganizationMembership` call to WorkOS. Local would say the user was in the target org while WorkOS — and therefore every read-side gate — disagreed. Now the WorkOS create happens first; only on success does the local row get written, with the WorkOS membership id cached.

Pre-existing drift is reconciled out-of-band, not via a shipped script. Future drift is prevented by the WorkOS-first ordering above and surfaced via the new audit-log actions.
