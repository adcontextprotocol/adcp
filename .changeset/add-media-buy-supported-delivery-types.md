---
"adcontextprotocol": minor
---

Declare which delivery modes a seller sells and grade guaranteed-only sellers on a matching baseline.

Adds the optional `media_buy.supported_delivery_types` capability (`guaranteed`, `non_guaranteed`; absent means both, so nothing changes for existing sellers). A seller that declares a subset MUST NOT list products of the other mode and MUST reject a `create_media_buy` for one with `UNSUPPORTED_FEATURE`.

Compliance: the `media_buy_seller` baseline and the inherited scenarios that need non-guaranteed fixtures now carry a `requires_capability` gate on `non_guaranteed`, so they grade `not_applicable` (no coverage, not a pass) for a guaranteed-only seller instead of failing on a `media_buy_id` that a guaranteed buy defers to task completion. The gates are temporary, tagged `TEMPORARY(adcp#7852)`, and the profile is reduced coverage until scenarios are delivery-mode aware. The new `media_buy_seller_guaranteed` baseline runs only for sellers that declare a set without `non_guaranteed` and grades the guaranteed core flow: discovery (including that no non-guaranteed product is listed), a `submitted` create, controller-forced completion, `get_task_status` polling, `get_media_buys` readback, and delivery reporting. A seller without a test controller gets a single storyboard-level `missing_test_controller` skip for that baseline, which is a coverage gap and not a complete grade. Rejecting a create on an undeclared mode is attestation-only. Sellers MUST emit a `media_buy` block in `get_adcp_capabilities`: the runner applies the absent-means-both default only when that object is present.

Not changed: scenario bodies and fixtures (making every inherited scenario delivery-mode-aware is deferred) and the runner-output contract. The compliance catalog's guaranteed-only note now states the rule.
