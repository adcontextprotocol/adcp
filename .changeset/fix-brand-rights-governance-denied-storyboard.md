---
---

Fix `acquire_rights_denied` step in `brand_rights/governance_denied` storyboard: replace `expect_error: GOVERNANCE_DENIED` with spec-correct `AcquireRightsRejected` (status: rejected) validation.

The storyboard expected the brand agent to throw an `AcquireRightsError` envelope with `code: GOVERNANCE_DENIED`, but `acquire-rights-response.json` defines `AcquireRightsRejected` (`status: rejected` + required `reason`) as the canonical first-class denial arm — matching the discriminated-union pattern across all brand-rights task responses. Spec-compliant agents returning `AcquireRightsRejected` failed this scenario despite passing `response_schema` validation. Drops `expect_error: true` and `negative_path: payload_well_formed`; adds `field_value: status=rejected`, `field_present: rights_id`, `field_present: brand_id`, `field_present: reason`. Updates storyboard narrative and summary accordingly. Closes #3914.
