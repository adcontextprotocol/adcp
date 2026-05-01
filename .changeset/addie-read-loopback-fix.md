---
---

Fix three GET-loopback Addie tools that were silently returning "Authentication required" because `callApi` sends no credentials and the routes require auth (issue #3748):

- `get_my_working_groups` — was failing for every signed-in member.
- `get_my_council_interests` — same.
- `get_my_content` — same.

Same root-cause shape as the state-change loopback bug class (#3736), different middleware (auth instead of CSRF). Fixed with the same pattern: extract a service that both the route and the Addie tool consume directly.

New service functions:
- `listMyWorkingGroups({userId})` — added to `working-group-membership-service`.
- `listMyCommitteeInterests({userId})` — added to `working-group-membership-service`.
- `listMyContent({userId, status, collection, relationship, limit})` — new `services/my-content-service.ts`. Throws `MyContentError` with `invalid_status` discriminator so adapters render the right message.

The content service needed admin-status detection (admins see all perspectives in their content list), and importing `isWebUserAAOAdmin` from `addie/mcp/admin-tools.ts` would have pulled `relationship-orchestrator` → `engagement-planner` → Anthropic into the test import graph (same chain that broke `claude-client-cost-gate` in PR #3741). Lifted the function into a thin `addie/admin-status-lookup.ts` module; `admin-tools.ts` re-exports for existing callers.

Closes #3748. The Addie loopback bug class is now fully resolved end-to-end:
- State-change side: closed by PRs #3716, #3741, #3743, #3747 (locked down).
- Read side: closed by this PR.
