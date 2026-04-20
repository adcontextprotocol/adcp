---
"adcontextprotocol": minor
---

Add `REQUOTE_REQUIRED` error code to the standard vocabulary. Sellers return this on `update_media_buy` when a requested change (budget, flight dates, volume, targeting) falls outside the parameter envelope the original quote was priced against. The `pricing_option_id` remains immutable on update; this code covers the case where the seller will not honor the existing price for the requested new shape of the buy.

Recovery is deterministic: the buyer calls `get_products` with `buying_mode: "refine"` against the existing `proposal_id` to obtain a fresh quote reflecting the new parameters, then resubmits the update against the new `proposal_id`. Sellers SHOULD populate `error.details.envelope_field` with the field path(s) that breached the envelope so the buyer's agent can autonomously re-discover.

Distinct from `TERMS_REJECTED` (measurement terms) and `POLICY_VIOLATION` (content). Recovery classification: correctable.

Closes #2456 (3.1 scope). The 4.0 `report_usage` counter-attestation portion (post-hoc delivery reconciliation) remains a separate RFC and should not overload this code.
