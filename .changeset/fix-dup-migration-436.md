---
---

fix(migrations): renumber duplicate 436 to 438 to unblock deploys

PRs #3282 and #3295 both shipped a `436_*.sql` migration in parallel before
PR #3288 (the duplicate-detection check) landed. The collision blocks every
subsequent deploy at the Preflight check that #3288 added — main is wedged
and prod is on stale code.

Renames `436_organization_membership_provisioning_source.sql` → `438_*` (the
later-merged of the two). Both migrations use `IF NOT EXISTS` so dev DBs
that already applied the file as 436 will see the renumbered 438 as a
no-op next migrate run; prod's `release_command` never succeeded with the
duplicate present, so prod applies it fresh as 438.

Updates the matching changeset reference in `provisioning-source-attribution.md`.
