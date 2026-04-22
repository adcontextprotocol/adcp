---
---

Drain the final 7 storyboard sample_request drift entries (adcp#2763). Allowlist goes to **zero** — ratchet is now fully strict.

Closes out the cluster arc kicked off by #2768 (lint) and worked through #2781 (auth), #2788 (format_id/signal_ids), #2798 (bundled drift), #2795 (asset_type discriminator + governance docs), #2799 (refine[] naming), #2801 (url-asset uri-template). After this merges, any new sample_request drift fails CI immediately.

Specific fixes:

- **3× `check_governance` fixtures dropped `account` additionalProperty.** `governance-delivery-monitor#initial_approval/check_governance_approved`, `#drift_recheck/check_governance_drift`, `governance-spend-authority#governance_check_conditions/check_governance_conditions`. The #2776 docs landed earlier made account rejection explicit; fixtures now match. `drift_recheck` also dropped stray `media_buy_id` at root (not a top-level property of `check-governance-request`).
- **`report_plan_outcome` fixture** restructured `outcome: {type: "media_buy_created", media_buy_id, total_budget, packages}` (object) to the canonical `outcome: "completed"` (enum string) + `seller_response: {seller_reference, committed_budget, packages}`.
- **`si_get_offering`** added the required `offering_id`.
- **`si_initiate_session`** added the required `identity` block with `consent_granted: true` + `anonymous_session_id`.
- **`deterministic-testing#deterministic_session/initiate_session`** added `consent_granted: true` to identity.

All 7 allowlist entries removed deterministically via shrink-only regeneration.
