---
---

spec(storyboards): document `field_less_than` and `field_equals_context` cross-step comparison checks (closes #2642)

Storyboard authors had no way to assert that a value in this step's response relates to a value captured by a prior step — every existing `check:` was single-step. `field_value` + `$context.<name>` substitution resolves the comparand at YAML authoring time against the *request*, not the response, so a seller could return a different id on `get_media_buys` than the one returned by `create_media_buy` and still pass.

The runner already implements both checks — `validateFieldLessThan` and `validateFieldEqualsContext` in `@adcp/sdk` read from `ctx.storyboardContext` (the accumulator populated by `context_outputs`), and `StoryboardValidation.context_key` is in the shipped types. Spec was lagging implementation. This PR catches the spec up.

**Changes:**

- `static/compliance/source/universal/runner-output-contract.yaml` — append `field_less_than` and `field_equals_context` to `authored_check_kinds`. Extend the `expected` / `actual` field docs in `validation_result` so runner output for the two kinds is unambiguous.
- `static/compliance/source/universal/storyboard-schema.yaml` — append the two kinds to the inline `check:` enumeration. Add a "Cross-step comparison" doc block alongside `refs_resolve` / `a2a_submitted_artifact` / `upstream_traffic`, including the `context_key` field, the literal-`value` fallback on `field_less_than`, and the `context_key_absent` skip semantics. Document `context_key` on the Validation object spec.

**Adoption:** unblocks the data-grounded validation pass on existing read steps tracked in #4291 (round-trip identity, filtered-vs-baseline, idempotency replay). No storyboard authors today.
