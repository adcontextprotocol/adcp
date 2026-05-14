---
---

Reinstate the foreign key on `brands.workos_organization_id` (dropped during the migration-389 hosted_brands→brands merge) and close the three drift paths that produced it: (1) `network-consistency-reporter` joins `organizations` so it no longer tries to insert a report for a brand whose owner org has been deleted (was firing a noisy FK violation into `#admin-errors` every cycle); (2) migration 474 adds the FK with `ON DELETE SET NULL`, nulls existing dangles, and installs a BEFORE UPDATE trigger that mirrors `deleteHostedBrand`'s relinquish state whenever the owner pointer is cleared (`manifest_orphaned=TRUE`, `is_public=FALSE`, `domain_verified=FALSE`, `prior_owner_org_id`-stash) so an org-delete never leaves a publicly-visible verified-but-unowned brand row in the registry; (3) `mergeOrganizations` reparents the secondary org's brands to the primary inside the merge transaction so the FK's `SET NULL` doesn't strip ownership when the secondary row is deleted.

Server-internal — no protocol surface changes. Follows the FK-less denormalized pointer drift playbook (PRs #4182/#4342/#4343 for the equivalent fix on `users.primary_organization_id`).
