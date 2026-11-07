---
"adcontextprotocol": patch
---

Compliance (experimental, `media_buy.hold_policy`, `media_buy.hold_extension`, `media_buy.hold_ranking`): six storyboards cover the hold acceptance cases from #8182. Each seeds products whose `hold_policy` it sets, so any seller that honors seeded policies can run it.

- `media_buy_seller/hold_policy_bounds` checks that finalize carries the draft's `hold_policy` forward with `hold_placed_at`, and that an exact retry returns the original `hold_placed_at` and `expires_at`. On the `reporting_subscription_probe` sandbox clock it also checks the exact window of a hold whose minimum equals its maximum: the same instants after the clock moves, and `PROPOSAL_EXPIRED` once the hold has lapsed.
- `media_buy_seller/hold_policy_terms_only` checks that a draft mixing holdable and non-holdable products commits terms only, and that a product without a policy follows `hold_semantics` (one phase per declared value). In a forced failure, a terms-only sibling gets `batch_aborted`, never `hold_unavailable`, and the batch finalizes once the directive has been consumed.
- `media_buy_seller/hold_policy_version_gate` checks that a 3.2-pinned caller sees no hold fields, and that finalizing a draft served at 3.3 with a terms-only policy fails for that caller with `UNSUPPORTED_FEATURE`.
- `media_buy_seller/hold_unavailable_batch` checks all-or-none finalize under `force_hold_unavailable`: the second draft gets `hold_unavailable`, its sibling `batch_aborted`, and an exact retry replays both. It needs no `hold_policy`.
- `media_buy_seller/hold_extension` covers `extend_hold`: an extension within `max_total_duration` and source supersession, a hold already at its ceiling, a policy that is not extendable, all-or-none extension batches, a commitment with no hold (`INVALID_STATE`), and the lapse past the ceiling on the sandbox clock.
- `media_buy_seller/hold_ranking` checks that two buyers on one rankable slot get `hold_rank` 1 and 2, and that the second buyer's hold reaches first position, and can be accepted, once the first buyer declines.

The runner contract gains `instant_offset_within`, which bounds an RFC 3339 instant by a base instant plus ISO 8601 durations, for example `hold_placed_at + min_duration <= expires_at <= hold_placed_at + max_duration`. The storyboards declare it advisory until a released runner implements it (adcontextprotocol/adcp-client#3602). Unknown checks already grade not_applicable.

`reporting_subscription_probe` now states that a seller that also lists `media_buy.hold_policy` places and expires holds on the same `simulated_now` clock.
