---
---

patch: storyboard for create_media_buy submitted-arm wire shape + new force_create_media_buy_arm test-controller scenario

Adds the conformance scenario adcontextprotocol/adcp#3081 — the AdCP-payload-level invariant for `create_media_buy` when it returns the submitted task envelope. Anchors the spec contract that adcp-client#899 (A2A serve adapter) implements at the transport layer:

- `status` MUST be the literal string `'submitted'` (not a MediaBuyStatus value, not omitted)
- `task_id` MUST be present at the top of the envelope (snake_case payload field; A2A adapters surface as `taskId` on the wire but the agent emits `task_id`)
- `media_buy_id` and `packages` MUST NOT appear on the envelope — they land on the task's completion artifact

Without this storyboard, a regressed seller emitting `media_buy_id` under `status: submitted` (or returning a MediaBuyStatus value where `'submitted'` is required) would pass every conformance run. The submitted-arm `not.required` clauses in `create-media-buy-response.json` were silent until something exercised them.

**New storyboard.** `static/compliance/source/protocols/media-buy/scenarios/create_media_buy_async.yaml`. Registered in `protocols/media-buy/index.yaml` `requires_scenarios:`. Uses `controller_seeding: true` to seed a guaranteed video product, then drives the submitted arm via the new controller scenario (below) before validating the envelope shape on `create_media_buy`.

**New test-controller scenario.** `force_create_media_buy_arm` in `comply-test-controller.mdx` and the request/response schemas under `static/schemas/source/compliance/`. Shapes the next `create_media_buy` call from the caller's authenticated sandbox account into a specific arm. v1 supports `submitted` (the async task envelope) and `input-required` (errors-branch); `completed` is covered by `seed_media_buy` + a normal flow, and `working` is an out-of-band progress signal rather than an initial response arm. Single-shot — consumed by the next call from this account, then the seller resumes default behavior; buyer-side `idempotency_key` semantics are unchanged (replayed requests return the cached response, not a re-evaluated directive). Required for the storyboard to be deterministic across implementations: most sellers route most buys synchronously, and no buyer-side request shape reliably triggers the submitted arm. Sellers without this scenario return `UNKNOWN_SCENARIO` and the storyboard grades `not_applicable`.

**Response schema.** `comply-test-controller-response.json` gains a fifth `oneOf` branch `ForcedDirectiveSuccess` with a `forced` envelope (`arm`, `task_id`). The directive is semantically distinct from `force_*_status` — there is no entity to transition, so `previous_state`/`current_state` would be misleading. The `list_scenarios` enum gains the new scenario name so sellers advertising it do not schema-fail their own list response.

**Out of scope.** Transport-level wire-shape probes (A2A `Task.state`, `artifact.metadata.adcp_task_id`; MCP envelope details) are runner concerns tracked at adcp-client#904. The submitted → completed transition (forcing task resolution and asserting the completion artifact carries `media_buy_id`) is deferred to a follow-up — it needs a `force_task_completion` controller scenario that does not exist yet.

Why patch: this is a conformance-suite content addition (new storyboard + new controller scenario, both opt-in via `UNKNOWN_SCENARIO`). No on-wire seller obligations change for sellers that already emit the submitted envelope per `create-media-buy-response.json`. Per the versioning rule clarified in `storyboards-patch-clarify.md`, conformance-suite changes version independently and are patch-level by default.
