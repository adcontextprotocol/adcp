---
---

Fix compliance storyboards to exercise GOVERNANCE_DENIED wire-placement rule.

The `brand_rights/governance_denied` scenario previously asserted `error_code: GOVERNANCE_DENIED`
on `acquire_rights`, which is the wrong wire shape: that task defines an `AcquireRightsRejected`
arm enforced by `not: { required: [errors] }` at the schema layer, so governance denial must
route through the rejection arm (status: rejected, reason populated, errors[] absent) with
transport staying at HTTP 200 / MCP `isError: false`.

Updated the scenario to assert the correct Case-1 shape. Updated the
`media_buy_seller/governance_denied` scenario's error_code description to document the
Case-2 wire-placement rule (create_media_buy has no rejection arm).
