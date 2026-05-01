---
---

Lock down `callApi` (the loopback HTTP helper inside `server/src/addie/mcp/member-tools.ts`) to GET-only — three layers of defense so the state-change loopback bug class from issue #3736 cannot regress:

1. **Type narrowing.** The `method` parameter is now `'GET'` only. TypeScript rejects `callApi('POST', …)` / `callApi('PUT', …)` / `callApi('DELETE', …)` / `callApi('PATCH', …)` at compile time. The `body` parameter is dropped — GETs don't carry one.
2. **Runtime guard.** Even if a future contributor casts past the type, the function throws on entry with a message that points to the service-layer pattern.
3. **Lint rule + CI gate.** `scripts/lint-callapi-state-change.cjs` walks `server/src/addie/mcp/` and fails CI on any `callApi('POST'|'PUT'|'DELETE'|'PATCH', …)` shape, double-quoted or single. Wired into `npm run test` and `npm run precommit` via `tests/lint-callapi-state-change.test.cjs` (7 tests covering source-tree-clean + per-method-flagged + GET-allowed).

Closes #3736 for the state-change bug class. PRs #3716, #3741, #3743 migrated all known state-change tools off loopback to direct service-layer calls; this PR prevents new ones from being introduced.

**Note discovered during smoke testing:** three GET-loopback Addie tools (`get_my_working_groups`, `get_my_council_interests`, `get_my_content`) hit `requireAuth`-protected endpoints and silently fail with "Authentication required" because `callApi` sends no credentials. Same root-cause shape but different middleware (auth vs CSRF) and not blocked by this PR. Filed separately as a follow-up.
