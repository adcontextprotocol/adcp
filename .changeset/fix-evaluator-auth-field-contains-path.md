---
"adcontextprotocol": patch
---

Fix `field_contains` path in `creative/evaluator_auth` storyboard to use `experimental_features[*]` so the array-membership check fans out over elements instead of comparing the whole array to the scalar value. Every conformant agent that declares `creative.evaluator` was incorrectly failing this step.
