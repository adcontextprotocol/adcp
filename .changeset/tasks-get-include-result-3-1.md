---
"adcontextprotocol": minor
---

feat(tasks/get): add `include_result` request flag and `result` response field for typed completion-payload retrieval

Closes #3123. The 3.0 `tasks/get` schemas defined task status, timing, history, progress, and error fields, but no typed mechanism for buyers polling a `submitted` task to retrieve the terminal payload (e.g. `media_buy_id` and `packages` from a completed `create_media_buy`). The 3.0 docs invited buyers to send `include_result: true` against a parameter that wasn't in the schema; the SDK at adcp-client read `status.result` against a field that wasn't there either. Patch #3127 corrected the docs for 3.0; this change adds the field for 3.1.

**Request schema** (`static/schemas/source/core/tasks-get-request.json`): added `include_result` (boolean, default `false`). Sellers MUST honor the flag when the task is in a terminal status; for non-terminal statuses (`submitted`, `working`, `input-required`, `auth-required`) the flag has no effect. Status-only polls remain cheap by default.

**Response schema** (`static/schemas/source/core/tasks-get-response.json`): added `result` (object, `additionalProperties: true`) populated only when `status: completed` and `include_result: true` was sent. Shape matches the original task response payload for the task's `task_type` — for example, `task_type: create_media_buy` returns `result: { media_buy_id, packages, status }`. For `failed`/`canceled`, sellers continue to use the existing `error` field; `result` is for the success terminal only. The `status: completed` constraint is documented in the field description rather than expressed via JSON Schema's conditional validation, matching how `error` documents its `failed` constraint.

**Why a typed `result` instead of flat top-level merge.** AdCP's flat-structure principle ("task fields at top level") applies to the original task response, where the response carries one task. `tasks/get` is a meta-call about an arbitrary task whose `task_type` is variable — flat-merging the terminal payload at top level would force progress/error/result fields to share namespace and would couple the tasks/get response shape to the union of every task's response shape. Naming the projection `result` makes the typed retrieval explicit, parallels MCP's `tasks/result` envelope, and matches what existing SDK code already attempts to read.

**Why minor and not patch.** Per `docs/reference/versioning.mdx`: "Add a new error code or new optional field to a request/response schema | Minor" and "Patches never change schema — no new fields, no renamed fields, no new enum values." Targets the 3.1 milestone (late June 2026).

**Docs**: added an explanatory paragraph to the polling section of `task-lifecycle.mdx`. The other four call sites (`async-operations.mdx` ×2, `error-handling.mdx`, `orchestrator-design.mdx`) where `include_result: true` was previously stripped by patch #3127 will be re-introduced when this branch rebases on the merged patch.

**Forward compatibility**: 3.0 sellers ignore unknown request fields per `additionalProperties: true`, so a 3.1 buyer sending `include_result: true` to a 3.0 seller gets the 3.0 behavior (no `result` field on the response) — no error, no break. Buyers that need 3.1 semantics check `adcp.major_versions` advertised by the seller.

**Cross-repo**: unblocks adcp-client#967 (SDK polling-cycle hardening) and adcp-client-python equivalent. The SDK's `pollTaskCompletion.TaskResult.data` extraction will read `response.result` when present, falling back to `response` for 3.0 sellers that splat task fields via `additionalProperties`.
