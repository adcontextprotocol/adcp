---
"adcontextprotocol": minor
---

feat(creative): advisory evaluator for build_creative (#5241)

Adds an optional, advisory `evaluator` input to `build_creative` (a buyer-attached pointer, #5280) and a per-leaf `eval` block on `BuildCreativeVariantSuccess` variants that explains the `recommended`/`rank` the agent already sets on the `best_of_n` axis. The evaluator is the rank-side of the `get_creative_features` feature oracle: the `eval` block reuses `creative/creative-feature-result.json` (the same feature-value shape `get_creative_features.results[]` returns), and ranking is a soft `rank_by` preference over those feature values (the `feature-requirement` predicate shape already shared by property/audience filters). Gating stays a separate hard predicate; the evaluator never gates which leaves are produced or billed. Gated by a new `creative.supports_evaluator` capability flag.

New schema: `core/evaluator-spec.json` (3-form oneOf: exemplars / evaluator_id / agent_url, an optional `rank_by` preference, plus a soft `eval_budget`). Non-breaking, fully additive; `list_evaluators` discovery is a noted follow-on. DRAFT RFC pending a WG decision record.
