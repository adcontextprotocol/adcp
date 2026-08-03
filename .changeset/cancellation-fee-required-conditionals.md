---
"adcontextprotocol": patch
---

Enforce `cancellation_fee.rate` / `.amount` by fee `type` in `cancellation-policy.json`. Both fields are documented as conditionally required — `rate` "Required when type is 'percent_remaining'", `amount` "Required when type is 'fixed_fee'" — and the requirement is restated in the pricing-models reference, but `cancellation_fee` listed only `["type"]` in `required[]`. A validator therefore accepted `{ "type": "percent_remaining" }` (or `{ "type": "fixed_fee" }`) with no fee value at all, leaving a money-path term that declares nothing computable for a buyer accepting the product's cancellation terms.

Adds `if/then` conditionals: `percent_remaining` requires `rate`, `fixed_fee` requires `amount`; `full_commitment` and `none` are unaffected. No prose change — this aligns the schema with the already-documented contract, and no existing example regresses (both doc examples already carry `rate`). Regression coverage added to `tests/composed-schema-validation.test.cjs`.
