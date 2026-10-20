---
"adcontextprotocol": minor
---

spec(media-buy): add the `operator_fee` price adjustment kind (#8329). An account's operator, typically an agency buying for a brand, often keeps a fee out of the advertiser's budget, such as a 2% insurance fee. Neither `fee` (paid to the seller) nor `commission` (does not change the buyer's price) could express it.

An `operator_fee` raises the price the advertiser pays without changing the seller's revenue. Its `beneficiary` defaults to the account's `operator`. Only the operator's buying platform adds it, in breakdowns returned to the operator and the advertiser; sellers MUST NOT include it in breakdowns or `eligible_adjustments` they author. Operator fees MUST follow every `fee` and `discount` adjustment. The running price before the first one is the seller's price, and commission and settlement apply to it. Like `fee`, `rate` is a markup on the running price.

The `price_breakdown` invariant now applies fee, discount, and operator fee adjustments to `list_price`. Seller breakdowns never carry `operator_fee`, so neither the invariant nor the seller's budget basis changes for sellers. A buying platform's budget toward the advertiser includes operator fees. Readers that meet an unrecognized adjustment `kind` SHOULD skip the invariant check. Like other new 3.3 enum values, send `operator_fee` only to 3.3 peers.
