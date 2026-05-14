---
"adcontextprotocol": patch
---

Fix migration 476 (`refresh_denormalized_user_email`) which was failing on prod
deploy with a `idx_person_relationships_email_unique` collision. The naive
`UPDATE person_relationships SET email = users.email` collided when two
relationship rows would land on the same email — the symptom of two
`person_relationships` rows pointing to the same person, or a stale row that
should have been merged when `users.email` was reassigned. The migration now
skips rows whose target email is already held by a different
`person_relationships` row; the in-app read self-heal continues to surface the
right email at display time, and the residual duplicates are left for separate
dedup. Unblocks the `Deploy` workflow on `main`, which had been failing on
release_command since #4481 merged.
