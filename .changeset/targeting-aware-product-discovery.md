---
"adcontextprotocol": minor
---

Unify targeting across `list_products`, `request_proposals`, `refine_proposals`, the `get_products` compatibility facade, configured product selection, and media-buy execution.

Buyers can now provide concrete `targeting_overlay` values during discovery and require product-scoped future targeting through `required_overlay_support`. Products disclose selectable `overlay_support`, sparse buyer-reviewable `targeting_resolution` changes, and opaque buyable `product_id` values: non-custom wholesale IDs remain stable for the same logical offer within seller and cache scope, while custom IDs remain lineage-bound. Product pricing and forecasts are bound to concrete effective targeting; future support alone guarantees selectability, not value-specific availability or forecasting. Buyers should prefer structured fields over equivalent brief prose, while sellers continue to apply explicit hard brief requirements. A material structured interpretation is confirmed at response-root `targeting_resolution.brief_targeting` for `request_proposals` and `get_products`, or on the affected `refine_proposals.results[]` entry for refinement instructions.

Move purchased placement selection into `targeting_overlay` alongside property and collection selection, while preserving creative placement references as routing-only. Fixed placement sets may be restated exactly across discovery, create, and update without advertising selectable support. Add typed device-platform exclusion with independently declared product support, and keep arbitrary buyer-supplied ad-server key/value targeting outside the protocol trust boundary. Put discovery and package resolution behind lifecycle-specific schemas, move demographic package execution readback to `targeting_resolution.demographics` before its 3.2 release, deprecate targeting-like product filters, add migration guidance and conformance coverage, and retain exact-only booked package execution.

Clarify that deterministic product filters exclude non-matching products in `brief`, `wholesale`, and `refine` modes, and add seeded behavioral conformance coverage that detects full and partial filter no-ops.

Update the buyer skill, Addie knowledge, and buyer learning modules to teach structured-first request decomposition and targeting-resolution review. Live training-agent support follows the generated 3.2 beta SDKs under issue #6199.
