---
"adcontextprotocol": patch
---

Runner output contract: document the branch-set `any_of` peer cascade exemption. `cascade_rules` now names a `branch_set_cascade_exemption` (parallel to `sole_stateful_step_exemption`) stating that a stateful peer's genuine failure or `peer_branch_taken` skip MUST NOT cascade `prerequisite_failed` onto a sibling phase sharing the same `branch_set.id` under `any_of` semantics — the peers are mutually-exclusive alternatives, not a dependency chain. The exemption is scoped to `any_of`, is N-ary-safe (any number of peers), leaves cross-set and within-phase cascade unchanged, and is explicitly `depends_on`-agnostic (it fires whether the sibling's dependency is the implicit default or an explicit `depends_on` naming the peer). `storyboard-schema.yaml`'s `depends_on` section gains a cross-reference. Documents-only; codifies the runner behavior shipped in adcp-client#2306 (closing adcp-client#2305), root-caused in adcp#5337. No schema or wire change.
