---
---

patch: force_task_completion controller scenario

Adds the controller primitive needed to test the async `create_media_buy` submitted → completed roundtrip end-to-end. Companion to `force_create_media_buy_arm` (#3104): that scenario drives the seller into the submitted envelope; this one closes the loop by transitioning the task store entry from `submitted` to `completed` and stamping the result that subsequent [`tasks/get`](/docs/protocol/calling-an-agent#async-task-polling) calls return when `include_result: true` (formalized in #3126).

**Scenario semantics.** `{ scenario: 'force_task_completion', params: { task_id, result } }`. The seller stores `result` (validated against `async-response-data.json`) against `task_id` and surfaces it verbatim on the next `tasks/get(task_id)` with `include_result: true`. Returns the standard `StateTransitionSuccess` shape with `previous_state: 'submitted'` / `current_state: 'completed'`. Sellers MUST emit `NOT_FOUND` for unknown task_ids and `INVALID_TRANSITION` if the task is already terminal.

**Files.**
- `static/schemas/source/compliance/comply-test-controller-request.json` — added to enum, new `result` param ($ref `async-response-data.json`), conditional `if/then` requiring `task_id` and `result`.
- `static/schemas/source/compliance/comply-test-controller-response.json` — added to `list_scenarios.scenarios` enum (sellers advertising support don't schema-fail their own list response). Reuses the existing `StateTransitionSuccess` branch.
- `docs/building/implementation/comply-test-controller.mdx` — new `### force_task_completion` section + inline params doc + tool-definition enum + example.

**Storyboard extension lives in the follow-up.** The `create_media_buy_async` storyboard is unchanged in this PR. Extending it to exercise the new scenario via `tasks/get` polling lands together with the training-agent's implementation of `force_task_completion`, mirroring the #3104 → #3115 pattern. That keeps the runner from grading the storyboard as `failed` during the window where the controller scenario exists in spec but no reference seller implements it yet (the half-implemented case can't gracefully degrade to `not_applicable` because the storyboard's earlier phases already pass).

Why patch: new sandbox-only controller scenario, opt-in via `UNKNOWN_SCENARIO` grading. No on-wire seller obligations change for sellers that already implement `tasks/get` with `include_result` per the schema.
