---
"adcontextprotocol": minor
---

`get_media_buy_delivery`: the `media_buy_deliveries[].by_package` description now says sellers SHOULD return at least one row, one per package in the media buy, and SHOULD omit a buy's delivery row and return an error when the buy cannot be reported, rather than return an empty `by_package`. Every media buy has at least one package, and buyers price, cap and reconcile delivery per package. No schema constraint changes in 3.x: `by_package: []` stays valid on the wire. Requiring at least one row (`minItems: 1`) is proposed for 4.0 in #8973.
