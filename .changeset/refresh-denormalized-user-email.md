---
"adcontextprotocol": patch
---

Fix stale email in admin person-detail view and member list after a primary-email swap. `person_relationships.email` and `organization_memberships.email` denormalize `users.email`, but the three write paths that mutate `users.email` (`mergeUsers`, `PUT /api/me/linked-emails/primary`, and the WorkOS `user.updated` webhook) were not all refreshing both denorms — the most common gap was `person_relationships.email`, which is what the admin "person" header reads. Refreshes are now applied in all three paths inside the same transaction as the swap, and a backfill migration (476) repairs the rows that already drifted.
