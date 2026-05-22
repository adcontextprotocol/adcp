---
---

Fix red main from PR #3398. Migration 478 (A2B hands-on lab) shipped `exercise_definitions[].success_criteria` as plain strings, but `SuccessCriterion` is `{id, text}` and `demonstrations-fairness.test.ts` asserts every criterion has an id — so main was failing the integration suite. Migration 479 converts each string criterion to `{id: "<exercise_id>_c<n>", text: <string>}`. Idempotent (skips entries already in object form). Server data only, no schema/protocol change.
