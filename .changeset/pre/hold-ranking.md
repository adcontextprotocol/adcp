---
"adcontextprotocol": minor
---

Add experimental hold ranking (feature id `media_buy.hold_ranking`, #8086) as advisory readback. `hold_policy` gains `rankable`, which defaults to `false` and is forbidden when `available` is `false`. Without `rankable: true`, `available: true` keeps its exclusive, first-position meaning. With it, finalize may place the hold behind holds that could prevent it from booking, and the committed proposal reports the buyer's own position in a new `hold_rank`. Position 1 is first; when the hold covers inventory at several positions, `hold_rank` is the worst of them. `hold_rank` is required on a committed proposal under a rankable policy, and forbidden otherwise and on drafts.

A hold at rank 1 keeps the acceptance guarantee. Behind first position, the seller MAY decline `accept_proposal` with `PRODUCT_UNAVAILABLE`, after which the proposal stays committed. Or it MAY return `submitted` while it settles the holds ahead, but it may not shorten their `expires_at`. Positions never get worse: no later hold or booking stands ahead of a live hold, so the snapshot is an upper bound. An `extend_hold` successor reports a fresh position that is never worse than its source's. Sellers disclose nothing about other buyers' holds beyond the count ahead. A draft is rankable if any allocated product is. Callers below 3.3 never receive these fields, and for them the seller treats `rankable` as `false`.

No right-of-first-refusal deadline or rank-change webhook is defined. The `PRODUCT_UNAVAILABLE` and `committed` descriptions now cover ranked holds. Adds `ranking` vectors and a `hold_rank_worsened` code to `test-vectors/hold-policy`.
