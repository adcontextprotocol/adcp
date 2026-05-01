---
---

Fix three Addie GET-loopback tools that silently 401 against `requireAuth` routes — service-layer extraction (issue #3748, read-tool variant of #3736).

**Root cause:** `callApi('GET', '/api/me/…', memberContext)` constructs an HTTP request with no auth credentials (no session cookie, no bearer). The routes at `GET /api/me/working-groups`, `GET /api/me/working-groups/interests`, and `GET /api/me/content` all use `requireAuth` middleware, which returns 401. Members asking Addie about their own data see _"Authentication required"_ instead of their actual data.

**Fix — same service-layer pattern as PRs #3741 / #3743 / #3747:**

- `get_my_working_groups` → calls `WorkingGroupDatabase.getWorkingGroupsForUser(userId)` directly (`wgDb` was already instantiated at module scope in `member-tools.ts`).
- `get_my_council_interests` → new `WorkingGroupDatabase.getCouncilInterestsForUser(userId)` method; route updated to use it too, eliminating the duplicated inline `pool.query`.
- `get_my_content` → new `services/member-content-service.ts` (`listContentForUser`) shared by both the Addie tool (no pageview enrichment, `isAdmin: false`) and the web route (`listContentForWebUser` wrapper that resolves `isAdmin` and enables pageviews).

The `relationship` filter is preserved in application code inside the service (cannot be pushed to SQL — the `is_author / is_proposer / is_lead` columns are computed expressions, not stored values).

Bumps `CODE_VERSION` to `2026.05.1` (tool implementation change).

**Deferred:** the optional `callApi('GET', '/api/me/…')` lint rule extension (see issue #3748 acceptance criteria) is a follow-on — it needs `/api/me/` scoping to avoid false positives on the 8 public-route GET callers that are unaffected.
