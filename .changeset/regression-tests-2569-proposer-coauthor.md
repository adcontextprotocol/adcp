---
---

test(member-tools): regression coverage for proposer edit-button and co-author add flow (#2569)

Adds 10 integration tests to `server/tests/integration/content-my-content.test.ts` covering the two bugs fixed in PR #2241:

1. **Proposer relationship in `GET /api/me/content`** — verifies that a user who is only the proposer (no `content_authors` row) sees `relationships: ['proposer']`, which drives the `canEdit` check in `admin-content.html`. Without this the Edit button disappears after first save.

2. **Co-author add/remove via `POST`/`DELETE /api/me/content/:id/authors`** — happy path with DB verification, 400 on missing `user_id` (the original bug), 400 on missing `display_name`, 403 non-owner, upsert deduplication with `display_order` preservation, proposer-removes success, co-author-cannot-delete 403, and 404 for a missing `authorId`.

Also adds a user-existence check to `POST /api/me/content/:id/authors` before the `INSERT` to prevent a Postgres FK violation from surfacing as 500 when a non-existent `user_id` is submitted. Returns 400 with a clear message instead.

Refs #2569.
