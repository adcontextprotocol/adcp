---
"adcontextprotocol": patch
---

spec(conformance): rejection-arm vs `errors[]` mutual-exclusion test + storyboard alignment

Closes #3998. The wire-placement guidance on `GOVERNANCE_DENIED` (shipped to `main` via #3929 and to 3.0.x via #3996) is normative MUST-language: when a task response defines a structured rejection arm (`AcquireRightsRejected`, `CreativeRejected`), the arm IS the canonical denial shape — sellers MUST NOT additionally emit the error code in `errors[]` or `adcp_error`. The schema enforces this with `not: { required: ["errors"] }` on each rejection arm.

Until now the rule was asserted only in prose. This change adds executable conformance:

- **`tests/rejection-arm-mutual-exclusion.test.cjs`** — schema-validation conformance check that fails before the storyboards do if the `not: { required: ["errors"] }` constraint regresses on either rejection arm. Asserts both directions: canonical rejection-arm shape (status + reason, no errors[]) accepts; rejection-arm with errors[] populated rejects. Wired into the aggregate `npm test` run.
- **`brand_rights/governance_denied` storyboard** — assertions corrected to the rejection-arm path. Was asserting `check: error_code, value: "GOVERNANCE_DENIED"` on a task whose canonical denial shape is `status: "rejected"` + `reason`. Now asserts `field_value path: "status" value: "rejected"` plus `field_present path: "reason"`. Closes the storyboard portion of #3914 (storyboard was rejecting spec-correct adopter responses).
- **`media_buy_seller/governance_denied` storyboard** — narrative tightened to make Case-2 of the rule explicit (no rejection arm → `errors[]` + `adcp_error` populated; transport markers flipped). Cross-references the brand-rights scenario as the Case-1 counterpart.

Wire format unchanged. Schema constraints unchanged. Pure conformance + documentation: the schema rule was already in place; this change makes it discoverable from a failing test and aligns the existing storyboards with the rule.
