---
"adcontextprotocol": minor
---

feat(creative): advisory evaluator for build_creative (#5241)

Adds an optional, advisory `evaluator` input to `build_creative` (a buyer-attached pointer, #5280) and a per-leaf `eval` block on `BuildCreativeVariantSuccess` variants that explains the `recommended`/`rank` the agent already sets on the `best_of_n` axis. The eval block mirrors the content-standards oracle `{verdict, features[]}` shape (binary-verdict + feature-check-status) and deliberately does NOT reuse the closed `creative-feature-result.json` quantitative-measurement schema. Gated by a new `creative.supports_evaluator` capability flag.

New schemas: `core/evaluator-spec.json` (3-form oneOf: exemplars / evaluator_id / agent_url + soft eval_budget) and `core/evaluator-result.json`. Non-breaking, fully additive; `list_evaluators` discovery is a noted follow-on. DRAFT RFC pending a WG decision record.
