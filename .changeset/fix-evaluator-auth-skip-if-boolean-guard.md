---
"adcontextprotocol": patch
---

Fix `evaluator_auth` storyboard: use truthiness form `!context.supports_evaluator` in all `skip_if` guards.

The storyboard used `context.supports_evaluator != true` (strict typed equality) to gate evaluator-specific phases. When a creative agent returns `creative.supports_evaluator: false`, the runner captures the boolean `false` into `context.supports_evaluator` but mishandles the `!= true` strict comparison — evaluating it as `false` instead of `true` — so the guarded phase executes instead of being skipped. The underlying bug is in the adcp-client runner's `skip_if` evaluator (tracked separately); this change applies a defensive storyboard workaround that is semantically equivalent for boolean values and avoids the typed equality path entirely.

Changed all six `skip_if` guards from `"context.supports_evaluator != true ..."` to `"!context.supports_evaluator ..."`, matching the truthiness style already used for `context.build_capability_id` and `context.creative_feature_id` in the same expressions. The storyboard was correctly authored per protocol semantics; the change is purely defensive against the runner bug during the 3.1 pre-release window.
