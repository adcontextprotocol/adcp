---
"adcontextprotocol": patch
---

test(compliance): add a media-buy compatibility storyboard for legacy package correlation without `product_id`.

The new non-required `media_buy_seller/package_correlation_legacy_fallback` scenario seeds a legacy-shaped media buy whose package omits `product_id` and verifies buyers can recover package correlation through persisted package `context.buyer_ref`.
