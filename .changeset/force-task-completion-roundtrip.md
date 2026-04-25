---
---

patch: force_task_completion controller scenario + create_media_buy_async storyboard extends to full submitted → completed roundtrip

Closes the loop on #3081 / #3104 / #3115. The `create_media_buy_async` storyboard previously validated only the submitted-envelope wire shape (`status='submitted'`, `task_id` present, no `media_buy_id`); the submitted → completed transition was deferred because no controller scenario could resolve the task deterministically. This PR adds the missing primitive and extends the storyboard to exercise the full async lifecycle, anchoring the spec invariants formalized in #3126 (typed `result` + `include_result` on `tasks/get`).

**New controller scenario `force_task_completion`.**

`{ scenario: 'force_task_completion', params: { task_id, result } }`. Resolves a submitted task to `completed` and stamps `result` (validated against `async-response-data.json`, the same `anyOf` union the push-notification webhook and `tasks/get` polling responses use) on the seller's task store. Subsequent `tasks/get(task_id, include_result: true)` MUST surface the result verbatim. Returns the standard `StateTransitionSuccess` shape with `previous_state: 'submitted'` / `current_state: 'completed'`. Sellers MUST emit `NOT_FOUND` for unknown task_ids and `INVALID_TRANSITION` if the task is already terminal. Added to:
- `static/schemas/source/compliance/comply-test-controller-request.json` (enum + `result` param + conditional `if/then` requiring `task_id` and `result`)
- `static/schemas/source/compliance/comply-test-controller-response.json` (added to `list_scenarios.scenarios` enum; reuses the existing `StateTransitionSuccess` branch)
- `docs/building/implementation/comply-test-controller.mdx` (new `### force_task_completion` section + inline params doc + tool-definition enum + example)

**Storyboard extension.** `static/compliance/source/protocols/media-buy/scenarios/create_media_buy_async.yaml` bumped from v1.0.0 to v1.1.0. Added `tasks_get` to `required_tools` and two new phases:
- `force_task_completion`: calls the controller with the captured `$context.forced_task_id` and a fixture `CreateMediaBuyResponse` result (`media_buy_id`, `packages`); asserts the state transition response.
- `poll_task_completed`: calls `tasks/get` with `include_result: true`; asserts `status='completed'`, `result.media_buy_id` matches the registered value (catches sellers that fabricate a fresh ID), and the response validates against `tasks-get-response.json`.

Title and summary updated to reflect the full roundtrip. Narrative documents the three new invariants the polling phase locks (status='completed' on terminal poll, include_result honored, result.media_buy_id verbatim).

**Out of scope.** Webhook (`push_notification_config`) delivery is not asserted; webhook conformance lives in dedicated webhook-receiver storyboards. Transport-level wire-shape probes (A2A `Task.state`, `artifact.metadata.adcp_task_id`) remain runner-side concerns at adcp-client#904.

Why patch: conformance-suite content addition + new sandbox-only controller scenario, both opt-in via `UNKNOWN_SCENARIO` grading. No on-wire seller obligations change for sellers that already implement `tasks/get` with `include_result` per the schema.
