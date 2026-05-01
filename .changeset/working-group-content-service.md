---
---

Extract a `working-group-content-service` shared by the route handlers and the four remaining Addie state-change tools that were silently CSRF-blocked via the loopback in `callApi`:

- `create_working_group_post` — was returning *"You're not a member of {slug}"* for actual members.
- `add_committee_document` — was returning *"You're not a member of {slug} committee"* for actual members.
- `update_committee_document` — same misleading "not a member" error.
- `delete_committee_document` — was returning *"You're not a leader of {slug}"* even when the user was a leader.

Same pattern as #3736 part 1 (#3741): both the route and the Addie tool consume the service directly. Service throws `WorkingGroupContentError` with discriminated codes (`group_not_found`, `not_member`, `not_leader`, `leader_required_for_public_post`, `missing_required_fields`, `invalid_post_slug`, `invalid_document_url`, `invalid_document_id`, `document_not_found`, `duplicate_post_slug`) so adapters render the right HTTP status / chat message — no HTTP-status guessing.

Side effects (Slack channel notification on new posts and documents, document indexing trigger, in-memory search-index refresh on update/delete) live in the service so they fire on every surface, web or chat.

The route's `isAllowedDocumentUrl` helper plus its three allowlist constants moved into the service so both consumers share a single SSRF allowlist for document URLs. The Addie tools keep a friendlier "Google only" pre-check that fires before the broader service-level allowlist — the service still re-validates as defense-in-depth.

**Behavior note:** the new service narrows `content_type` on `POST /api/working-groups/:slug/posts` to the allowlist `'article' | 'link'` — anything else is coerced to `'article'`. The Slack notification helper has always required this shape, so any prior request that sent e.g. `'discussion'` was inserting a row into `perspectives` that the public surface couldn't render correctly anyway. Addie callers were already pre-mapping (`post_type === 'link' ? 'link' : 'article'`), so they're unaffected.

Closes the addie-side half of issue #3736 — all 7 affected tools now go through service layers rather than the broken loopback. Part 3 (locking down `callApi` POST/PUT/DELETE/PATCH at runtime so future tools physically cannot reintroduce the bug class) follows in the next PR.
