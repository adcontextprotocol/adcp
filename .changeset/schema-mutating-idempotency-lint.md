---
---

spec(schemas): lint mutating request schemas for idempotency_key in required[] (#2377)

Companion to PR #2373's storyboard-level lint. The storyboard lint only
fails when a storyboard step declares `sample_request` but omits
`idempotency_key` — if the underlying request schema never required the
field in the first place, the lint treats the task as non-mutating and
silently passes. A new mutating request schema that forgets to mark
`idempotency_key` as required would therefore bypass both enforcement
points.

`scripts/build-schemas.cjs` now fails the build if any `*-request.json`
under `static/schemas/source/` appears to represent a mutating operation
without declaring `idempotency_key` in its top-level `required` array.
A schema is considered non-mutating when:

1. Its basename matches `(^|-)(get|list|check|validate|preview)-` —
   covers `get_*`, `list_*`, `check_*`, `validate_*`, `preview_*`
   operations, plus prefixed variants like `si-get-offering-request.json`.
2. It's one of a short NON_OPERATION_ALLOWLIST of core/utility types
   that aren't operations themselves — `pagination-request.json`,
   `package-request.json`, `tasks-get-request.json`,
   `tasks-list-request.json`, `comply-test-controller-request.json`,
   `context-match-request.json`, `identity-match-request.json`.
3. Its `$comment` or `description` contains the phrase
   "naturally idempotent" (case-insensitive) — the explicit exemption
   pattern documented in
   `sponsored-intelligence/si-terminate-session-request.json`, where
   `session_id` is the natural dedup boundary.

Otherwise the schema MUST list `idempotency_key` in its top-level
`required` array.

Error message surfaces the three fix options (add to required[] / rename
to read-only prefix / add naturally-idempotent exemption) so the next
author doesn't have to read the lint source to understand the contract.

All existing request schemas pass unchanged.
