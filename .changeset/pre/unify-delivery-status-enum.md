---
"adcontextprotocol": minor
---

Extract `enums/delivery-status.json` and `$ref` it from `get-media-buys-response.json`, `get-media-buy-delivery-response.json`, and `media-buy-delivery-webhook-result.json`. These three schemas previously inlined `delivery_status` independently: the `get_media_buys` snapshot path had 6 values (including `not_delivering`), while the delivery report and webhook paths only had 5. A buyer polling `get_media_buy_delivery` or receiving a delivery webhook had no way to observe `not_delivering` even though that is precisely the "zero delivery during flight" signal those paths exist to surface. All three now resolve to the same 6-value enum.

Fixes #6103.
