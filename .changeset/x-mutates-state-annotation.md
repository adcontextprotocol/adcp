---
---

spec + tooling: x-mutates-state annotation on request schemas (#2675)

Replaces the contradiction lint's idempotency-key inference +
hardcoded-exception model with an explicit `x-mutates-state: true`
annotation on each mutating request schema. Decouples two concerns
that happen to correlate ~95% of the time:

- **Mutation semantics** (`x-mutates-state: true`) — "this task changes
  observable server state a later conformant call may assert against."
- **Idempotency mechanism** (`required: [idempotency_key]`) — "replay
  dedup requires a key on the request."

The two sets legitimately diverge for naturally-idempotent mutations:
`comply_test_controller` (scenario enum is the dedup boundary) and
`si_terminate_session` (session_id is the dedup boundary). Before this
PR both were carved out via a `MUTATING_EXCEPTIONS` set in
`scripts/lint-storyboard-contradictions.cjs` — a drift hazard that
required documented rationale for each entry. Now both declare
`x-mutates-state: true` directly in their schemas, the exception set
is gone, and the lint reads one source of truth.

**Changes:**
- 31 `*-request.json` schemas under `static/schemas/source/` gain
  `"x-mutates-state": true` (29 previously detected via
  `idempotency_key` + 2 previously exceptions).
- `loadMutatingTasksFromSchemas` reads `schema['x-mutates-state'] === true`.
- `MUTATING_EXCEPTIONS` removed from `lint-storyboard-contradictions.cjs`.
- `storyboard-schema.yaml` gains a normative paragraph describing
  `x-mutates-state` semantics and enumerating included task classes.
- `build-compliance.cjs` retains its idempotency-key read (separate
  concern) with an inline comment explaining the divergence.

**Tests updated:**
- Drift guard: `MUTATING_TASKS` equals the schema-derived set exactly
  (no exception side channel).
- Positive anchors expanded to include `comply_test_controller` and
  `si_terminate_session`.
- Negative anchors unchanged (`get_products`, `get_signals`,
  `list_creative_formats`, `get_adcp_capabilities` must not appear).
- Total: 24 contradiction tests pass (was 25 — dropped the now-
  vestigial "every exception absent from derived" test).
