---
"adcontextprotocol": patch
---

Gate the `create_media_buy` submitted-arm compliance storyboard on the seller advertising `force_create_media_buy_arm` under `compliance_testing.scenarios`. Sellers without that sandbox-only forcing capability now skip the whole storyboard before its independent downstream phase can incorrectly fail their otherwise conformant synchronous or provisional media-buy flow.
