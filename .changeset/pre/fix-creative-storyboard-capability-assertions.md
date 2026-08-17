---
"adcontextprotocol": patch
---

Fix false failures in creative compliance storyboards (canonical_supported_formats, evaluator_auth).

`canonical_supported_formats`: removes the hardcoded `capability_id: "training_image_generation"` assertion (capability_id is agent-local; any valid value must pass) and the `field_absent` check on `supported_formats[1]` (agents may advertise multiple canonical formats). Fixes `context_outputs` field name from `key:` to `name:`.

`evaluator_auth`: adds `requires_capability` guards to all five optional phases so agents that correctly declare `creative.supports_evaluator: false` receive `not_applicable` instead of failing the evaluator track. Guards evaluate against the raw capabilities response, bypassing a runner-side boolean-false accumulator bug. Fixes `context_outputs` field name from `key:` to `name:`.
