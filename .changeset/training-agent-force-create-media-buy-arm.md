---
---

training-agent: implement `force_create_media_buy_arm` controller scenario + storyboard CI fixes

Wires the training-agent (this repo's reference seller) to handle the `force_create_media_buy_arm` scenario added in #3104. The `create_media_buy_async` storyboard now grades **passing** instead of `not_applicable` against the training-agent — the conformance suite catches submitted-envelope wire-shape regressions for real, not just on paper.

**Controller scenario.** `handleComplyTestController` pre-dispatches `force_create_media_buy_arm` before delegating to the SDK's `handleTestControllerRequest` (the SDK's enum is closed; new scenarios from spec PRs land in the wrapper until the SDK adopts them). The handler implements `arm: 'submitted'` only — `arm: 'input-required'` is reserved in the spec but cannot be expressed on a conformant `create-media-buy-response.json` today (`INPUT_REQUIRED` is a task-status, not a value in the canonical error-code enum, and the response schema has no fourth `oneOf` branch for an input-required envelope). The training-agent rejects that arm with `INVALID_PARAMS` until the spec resolves it. The handler validates `task_id` (required for submitted, max 128 chars), `message` (max 2000 chars), and writes to a new single-shot `forcedCreateMediaBuyArm` slot on `session.complyExtensions`. `list_scenarios` is augmented post-SDK-dispatch to include the new scenario name so storyboards detect support.

**Directive consumption.** `handleCreateMediaBuy` reads-and-clears the directive at the top of the handler — before account-status, governance, and idempotency gates — and returns the submitted task envelope (`status: 'submitted'`, `task_id`, optional `message`). Single-shot — the second `create_media_buy` from the same session resumes default behavior. Buyer-side `idempotency_key` replay still wins because the SDK's request-idempotency cache wraps this handler.

**Session persistence.** `forcedCreateMediaBuyArm` lands in `ComplyExtensions` (alongside the seed / account-status / etc. fields) so it survives the structuredSerialize/Deserialize round-trip every request does. `state.ts`'s `deserializeSession` carries it through explicitly.

**CI overlay fix.** `.github/workflows/training-agent-storyboards.yml` now mirrors *new* source files onto the SDK cache, not just edits to existing ones. The previous `if [ -f $DST/file ]` gate skipped any file the cache didn't already have — which silently meant new storyboards never ran in CI until the SDK published a fresh cache. Mirror the source tree fully and let `mkdir -p` create any new subdirectories on the cache side.

**CI baselines bumped.**
- Legacy: `52 → 53` clean storyboards, `380 → 384` passing steps (the new scenario adds 4 passing steps).
- Framework: `41 → 42` clean storyboards, `370 → 374` passing steps (same delta; framework stays below legacy due to the unrelated 5.17.0 sync_plans / property-list regression tracked at adcontextprotocol/adcp-client#940).

**Tests.** New `server/tests/unit/training-agent-force-create-media-buy-arm.test.ts` covers: directive registration for the submitted arm, INVALID_PARAMS for `input-required` (with explanatory error_detail), out-of-spec arm values, missing/over-length task_id, round-trip into the submitted envelope, single-shot semantics, overwrite-before-consume, and `list_scenarios` advertisement.

Why patch: training-agent-only implementation work, no spec changes. Closes the loop on #3081 — the scenario originally graded `not_applicable` until at least one reference seller implemented the controller scenario; this is that implementation.
