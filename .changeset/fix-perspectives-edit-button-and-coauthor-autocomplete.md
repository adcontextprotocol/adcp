---
---

Fix two bugs on the content admin (`/dashboard/content`):

- **Edit button now shown for proposers.** Previously the UI only rendered the Edit button for `owner` or `author` relationships, while the server also allows `proposer` to edit. Proposers whose author record wasn't present (data inconsistency, co-author removal, etc.) lost the ability to edit their own submissions.
- **Co-author add now uses autocomplete.** The input previously sent only `display_name`, but the API requires a `user_id` (WorkOS ID) — so every add failed with 400. Replaced the free-text field with a debounced search against `/api/community/people` that returns a candidate's `workos_user_id` and display name, then POSTs both to `/api/me/content/:id/authors`.

Co-author search only matches people with a public AAO profile. External co-authors are not yet supported.
