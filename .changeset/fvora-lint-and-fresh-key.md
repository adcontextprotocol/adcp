---
---

fix(compliance): add field_value_or_absent to contradiction-lint allowlist and cover fresh-key idempotency step

Follow-up to #3032 (documented the check) and #3034 (restored the initial-step `replayed` assertion). Two small gaps remained, both surfaced when triaging the superseded PR #3037:

1. **`scripts/lint-storyboard-contradictions.cjs`** — `hasPositiveAssertion` listed `field_present`, `field_value`, `response_schema`, `http_status`, `http_status_in` but not `field_value_or_absent`. Any storyboard using `field_value_or_absent` as its only positive assertion was misclassified as `unspecified`. Added to the allowlist so the linter correctly classifies such steps as `success`.

2. **`static/compliance/source/universal/idempotency.yaml`** — the `create_media_buy_fresh_key` step is a non-replay call, so the same `replayed` tolerance that #3034 restored on `create_media_buy_initial` applies here: `replayed` MAY be omitted, but if present MUST NOT be `true`. Added the symmetric `field_value_or_absent [false]` assertion so fresh-key coverage is not weaker than initial-call coverage.

Non-breaking: both additions are purely additive (new allowlist entry + new optional assertion on a step that was already asserting other fields). Agents that omit `replayed` on fresh execution pass both (spec-correct). Only agents setting `replayed: true` on a fresh call fail — already a spec violation per PR #3013.
