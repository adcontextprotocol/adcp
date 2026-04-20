---
---

Fix `org_activities_organization_id_fkey` violation on user login.

Local `organizations` rows are created lazily (first billing/agreement event) and the startup `syncFromWorkOS` was both startup-only and non-paginating (`limit: 100`), so orgs created in WorkOS after boot — or beyond the first page — were missing locally. `recordUserLogin` then blew up on the FK.

- Fix pagination in `OrganizationDatabase.syncFromWorkOS` (loop on `listMetadata.after`).
- Add `OrganizationDatabase.ensureOrganizationExists` — lazy-creates the local row from WorkOS data on demand, with race-safe fallback.
- Call it from the auth callback before `recordUserLogin`.
- Keep a `WHERE EXISTS` guard in `recordUserLogin` as belt-and-suspenders.
