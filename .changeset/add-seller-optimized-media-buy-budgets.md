---
"adcontextprotocol": minor
---

Add seller-optimized shared budgets and explicit bidding policy placement across media-buy packages. Media buys and proposals can delegate cross-package allocation to the seller under an aggregate budget, optimization goals, pacing, package caps, and soft minimum-spend targets, while preserving fixed package budgets as the default. A new media-buy/package `bidding` block separates objective functions from automatic bidding, manual bids, auction ceilings, average-cost controls, and ROAS controls, with complete-block inheritance and authored-scope-preserving readback. Media-buy outcome controls bind to allocation goals in seller-optimized mode and compatible package goals in fixed mode; package controls bind to package goals. All canonical monetary fields use one media-buy currency, ROAS event sources declare supported value currencies, and structured capabilities advertise support by scope, allocation context, mode, strength, and combination.
