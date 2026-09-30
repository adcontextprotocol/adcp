---
"adcontextprotocol": patch
---

compliance(media-buy): `delivery_reporting` (1.0.1) seeds `non_guaranteed` fixture products. Sellers that declare only `sales-non-guaranteed` no longer fail `create_media_buy` with `DELIVERY_MODE_NOT_SUPPORTED`. This is the same fix as #5703 and #5731, backported from #7770. Pricing stays `fixed_price` because the create steps send no bid. Test fixtures only.
