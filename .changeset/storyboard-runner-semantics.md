---
"adcontextprotocol": patch
---

Formalize storyboard runner semantics:

- `comply_test_controller` gains five `seed_*` scenarios (`seed_product`, `seed_pricing_option`, `seed_creative`, `seed_plan`, `seed_media_buy`) so storyboards can declare prerequisite fixtures by stable ID without implementers having to guess which IDs the conformance suite expects (closes #2584).
- Adds a declarative `fixtures:` block and `prerequisites.controller_seeding` flag to the storyboard schema. The runner auto-injects a fixtures phase that seeds via the new `seed_*` scenarios (closes #2585, Pattern A).
- Specs the existing `context_outputs:` capture + `$context.<name>` substitution mechanism that the runner already implements but was previously undocumented (closes #2585 Pattern B and #2589).
- Tightens the context-echo contract: MUST echo on both success and error, MUST NOT synthesize when the caller sent none, MUST NOT mutate. Storyboards MUST declare `context:` explicitly on any sample_request whose validator asserts on echoed context — runners MUST NOT auto-inject (closes #2589).

No wire-breaking changes. The `comply_test_controller` scenario enum is extensible and adds new values only; existing agents are unaffected until they adopt `seed_*`.
