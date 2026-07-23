---
"adcontextprotocol": minor
---

Partial validation hardening (targets 3.2): enforce `check_id` on budget-committing `report_plan_outcome` outcomes. The schema description and task reference both state `check_id` is "Required for `completed` and `failed` outcomes," but `report-plan-outcome-request.json` never listed it in any `required[]`, so a conformant validator accepted a budget-committing self-report with no reference to the authorizing `check_governance` decision.

Adds an `if/then` conditional: when `outcome` is `completed` or `failed`, `check_id` is required; `delivery` outcomes (not budget-committing) are unaffected. This aligns the schema with the already-documented contract — no prose change.

**Scope note:** this is not the fix for #5827. `check_id` is a correlator, not a cryptographic binding between the verified authorization and the committed budget; the bound-token work that actually closes the P0 is deferred to the 3.2 governance design. This change only closes the enforcement drift where the schema failed to require a field its own prose marks required. Regression coverage added to `tests/composed-schema-validation.test.cjs`.
