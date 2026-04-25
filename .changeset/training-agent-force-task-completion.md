---
---

patch: training-agent implements force_task_completion + bumps @adcp/client to 5.18.0

Wires the training-agent (this repo's reference seller) to handle the `force_task_completion` controller scenario from #3138 — the spec primitive that resolves a previously-submitted task to `completed` with a buyer-supplied result payload. Companion to #3115 (which implemented `force_create_media_buy_arm`).

**Controller scenario.** `handleComplyTestController` pre-dispatches `force_task_completion` before delegating to the SDK's `handleTestControllerRequest` (the SDK's enum is closed; new spec scenarios live in the wrapper until adopted upstream). The handler validates `task_id` (required, non-empty, ≤128 chars), `result` (required, plain object), and the soft 256 KB result-payload cap. It records `(task_id, result, ownerKey)` in a process-global Map so cross-account replays return `NOT_FOUND` (per the spec MUST), same-params replays are idempotent no-ops, and diverging-params replays against a terminal task return `INVALID_TRANSITION`. `list_scenarios` is augmented to advertise the new scenario.

**Why a local Map and not the SDK task store.** `@adcp/client` 5.18.0 (adcp-client#996, this PR's bump) added `PostgresTaskStore.createTask({ taskId })` for caller-supplied IDs — meaningful progress. But two adjacent gaps still block end-to-end roundtripping through the SDK task store:

1. `InMemoryTaskStore` (re-exported from `@modelcontextprotocol/sdk`) doesn't yet honor caller-supplied IDs. The training-agent falls back to InMemory in test/CI without `DATABASE_URL`, so an SDK-backed implementation would silently get random IDs in CI.
2. The SDK auto-registers `tasks/get` with the MCP `Task` shape (`taskId`, `status` ∈ `working|completed|failed|input_required|cancelled`); the AdCP `tasks-get-response.json` schema requires the AdCP shape (`task_id`, `status` ∈ `submitted|working|input-required|completed|canceled|...`, plus `task_type`, `protocol`, `result`, etc.). A storyboard polling phase asserting against the AdCP schema fails against the SDK's auto-registered handler.

Both gaps are tracked in adcp-client#994. The local-Map controller-side primitive ships the spec contract sellers must honor (cross-account NOT_FOUND, replay idempotency, terminal INVALID_TRANSITION) without depending on infrastructure that isn't there yet. When upstream lands, swapping the storage layer is mechanical.

**Storyboard extension still deferred.** The `create_media_buy_async` storyboard remains v1.0.0 (submitted-arm only). The polling phase needs Gap 2 above to land and the storyboard runner needs to thread caller-supplied IDs through tool input. Both are tracked in adcp-client#994.

**SDK upgrade fallout.** `@adcp/client` 5.18.0 broadened the `step.hints` type to a union (`ContextValueRejectedHint | ShapeDriftHint | MissingRequiredFieldHint | FormatMismatchHint | MonotonicViolationHint`). `renderAllHintFixPlans` now accepts the broader `StoryboardStepHint[]` and filters to `context_value_rejected` internally — other hint kinds will get their own fix-plan templates as authors demand them.

**Tests.** New `server/tests/unit/training-agent-force-task-completion.test.ts` (9 tests): directive registration with valid params, INVALID_PARAMS for missing/oversized fields, replay idempotency, diverging-replay INVALID_TRANSITION, cross-account isolation NOT_FOUND, list_scenarios advertisement. Existing `comply-test-controller.test.ts` length assertion bumped 8→9 to cover the new local scenario.
