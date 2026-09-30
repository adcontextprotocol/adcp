---
"adcontextprotocol": patch
---

compliance(media-buy): `delivery_reporting`, `advanced_delivery_reporting`, `revenue_share_pricing`, and `metric_container_subsumption` (1.0.1) seed `non_guaranteed` fixture products, so sellers that declare only `sales-non-guaranteed` no longer fail `create_media_buy` with `DELIVERY_MODE_NOT_SUPPORTED`. Follow-up to #7754 / #7756 (same fix as #5703 and #5731). Pricing stays `fixed_price` (or contingent, for `revenue_share_pricing`) because the create steps send no bid. `revenue_share_pricing`'s `is_guarantee_basis` measurement window is not conditioned on `delivery_type`. `metric_container_subsumption` keeps its deterministic container-vs-leaf disambiguation by swapping the two products' delivery types (and the discovery filter) instead of gating. Test fixtures only.
