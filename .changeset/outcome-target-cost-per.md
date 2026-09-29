---
"adcontextprotocol": minor
---

Add an optional cost target to `criteria.outcome_target`. `outcome_target.cost_per` carries `amount`, `strength` (`cap` or `target`, with the same semantics as `BiddingPolicy.cost_per`), and `currency`. `BiddingPolicy.cost_per` has no currency because it inherits the media-buy currency, and no media-buy currency exists at request time, so the request states it. `volume` becomes optional; at least one of `volume` or `cost_per` is required, so every document valid today stays valid.

A buyer can now ask for "clicks at 3 or less on a 5,000 budget" without pre-computing a volume. The seller plans the volume it can deliver within the budget at the cost, or toward a stated volume at the cost. It answers in the proposal's `commercial_terms.bidding.cost_per` with the buyer's `strength` and its own `amount`, which MAY be higher than the ask. A cap of 3 the seller can only meet at 4.50 comes back as `{ amount: 4.50, strength: "cap" }`, never as a target. The policy binds to a primary optimization goal matching `outcome_target.goal`.

`cost_per.currency` MUST equal `offer_filters.budget_range.currency` when present, and it is the currency of the answer: `commercial_terms.total_budget`, `total_budget_guidance`, and `forecast` on each answering proposal MUST use it. Sellers MUST NOT convert currency. A declaring seller that cannot plan against the cost target, including a currency the requested products are not priced in, rejects with `INVALID_REQUEST` naming `criteria.outcome_target.cost_per`.

The `media_buy_seller/outcome_target` storyboard adds three phases: a clicks cost cap on a budget, a clicks volume at a cost cap with no budget range, and a rejection of a EUR cost target against the USD-only fixture. The training agent plans cost targets deterministically from the fixture rate card.
