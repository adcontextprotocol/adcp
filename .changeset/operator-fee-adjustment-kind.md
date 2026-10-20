---
"adcontextprotocol": minor
---

spec(media-buy): add the `operator_fee` price adjustment kind (#8329). An account's operator, typically an agency buying for a brand, often keeps a fee out of the advertiser's budget, such as a 2% insurance fee. Neither `fee` (paid to the seller) nor `commission` (does not change the buyer's price) could express it.

An `operator_fee` raises the price the advertiser pays without changing the seller's revenue. Its `beneficiary` defaults to the account's `operator`. It appears only in breakdowns the operator's buying platform returns to the operator and its principal; sellers MUST NOT include it in breakdowns or `eligible_adjustments` they author.

The `price_breakdown` invariant now walks `list_price` through fee, discount, and operator fee adjustments to the buyer's effective price. Seller-authored breakdowns never carry `operator_fee`, so the invariant is unchanged for them.
