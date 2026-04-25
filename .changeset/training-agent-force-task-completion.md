---
---

patch: training-agent implements force_task_completion

Wires this repo's reference seller to the `force_task_completion` controller scenario from #3138 — the spec primitive that resolves a previously-submitted task to `completed` with a buyer-supplied result payload. Companion to #3115 (`force_create_media_buy_arm`); rebased onto #3191 (the `@adcp/client` 5.18.0 bump that ships `PostgresTaskStore.createTask({ taskId })`).

**Controller scenario.** `handleComplyTestController` pre-dispatches `force_task_completion` before delegating to the SDK (the SDK's `CONTROLLER_SCENARIOS` enum is closed; new spec scenarios live in the wrapper until adopted upstream). Validates `task_id` (non-empty, ≤128 chars), `result` (plain object), and a soft 256 KB cap on the payload. Records `(task_id, result, ownerKey)` in a process-global Map so cross-account replays return `NOT_FOUND` (per the spec MUST), identical-params replays are idempotent no-ops, and diverging-params replays against a terminal task return `INVALID_TRANSITION`. `list_scenarios` is augmented to advertise the new scenario.

**Why a local Map and not the SDK task store.** 5.18.0 ships `PostgresTaskStore.createTask({ taskId })` — meaningful progress, but two adjacent gaps still block SDK-backed roundtripping:

1. `InMemoryTaskStore` (re-exported from `@modelcontextprotocol/sdk`) doesn't yet honor caller-supplied IDs. Training-agent CI without `DATABASE_URL` falls back to InMemory, so an SDK-backed implementation would silently get random IDs there.
2. The SDK auto-registers `tasks/get` with the MCP `Task` shape (`taskId`, status ∈ `working|completed|failed|input_required|cancelled`); the AdCP `tasks-get-response.json` schema requires the AdCP shape (`task_id`, status ∈ `submitted|working|input-required|completed|canceled|...`, plus `task_type`, `protocol`, `result`). A storyboard polling phase asserting AdCP fails against the SDK's auto-registered handler.

Both tracked in adcp-client#994. The local-Map primitive ships the spec contract sellers must honor (cross-account NOT_FOUND, replay idempotency, terminal INVALID_TRANSITION) without depending on infrastructure that isn't there yet. Swapping the storage layer is mechanical when upstream lands.

**Storyboard extension still deferred.** `create_media_buy_async.yaml` remains v1.0.0 (submitted-arm only). The polling phase needs Gap 2 to land plus storyboard-runner wiring to thread caller-supplied IDs through tool input.

**Tests.** New `server/tests/unit/training-agent-force-task-completion.test.ts` (9 tests): directive registration, INVALID_PARAMS for missing/oversized fields, replay idempotency, diverging-replay INVALID_TRANSITION, cross-account NOT_FOUND, list_scenarios advertisement. `comply-test-controller.test.ts` length assertion bumped 8→9.
