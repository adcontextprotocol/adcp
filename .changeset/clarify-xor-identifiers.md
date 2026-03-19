---
"adcontextprotocol": patch
---

Clarify mutual exclusivity of identifier parameters in `update_media_buy` docs: `media_buy_id` xor `buyer_ref` at the campaign level, `package_id` xor `buyer_ref` at the package level. Supplying both or neither now explicitly documented as a validation failure.
