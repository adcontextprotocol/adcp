---
"adcontextprotocol": patch
---

compliance(media-buy): `canonical_formats` (1.1.1), `billing_finality_delivery`, `measurement_accountability`, and `vendor_metric_accountability` (1.0.1) seed `non_guaranteed` fixture products, so sellers that declare only `sales-non-guaranteed` no longer fail `create_media_buy` with `DELIVERY_MODE_NOT_SUPPORTED`. This is the same fix as #5703 and #5731. Pricing stays `fixed_price` because the create steps send no bid. `is_guarantee_basis` is not conditioned on `delivery_type`. `measurement_accountability`'s fixture now declares `completed_views` so it matches its own discovery filter. Test fixtures only.
