---
---

Renumbers `436_organization_membership_provisioning_source.sql` to `438_*` to break the duplicate-migration deadlock on main. PRs #3294 and #3295 both landed migration 436 simultaneously, blocking every open PR at the duplicate-check and migration-build CI gates. 437 is already taken by an unrelated `auto_provision_digest_sent_at` migration that landed in the same window, so this lands at 438.
