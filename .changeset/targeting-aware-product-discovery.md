---
"adcontextprotocol": minor
---

Unify targeting across `get_products`, configured product selection, and media-buy execution.

Buyers can now provide concrete `targeting_overlay` values during discovery and require product-scoped future targeting through `required_overlay_support`. Products disclose selectable `overlay_support`, sparse buyer-reviewable `targeting_resolution` changes, and opaque buyable `product_id` values that remain stable within a discovery/refinement context without promising validity in independent discovery contexts. Product pricing and forecasts are bound to effective targeting. Buyers should prefer structured fields over equivalent brief prose, while sellers continue to apply explicit hard brief requirements and can confirm inferred predicates once at response-level `targeting_resolution.brief_targeting`.

Move purchased placement selection into `targeting_overlay` alongside property and collection selection, while preserving creative placement references as routing-only. Add typed device-platform exclusion with independently declared product support, and keep arbitrary buyer-supplied ad-server key/value targeting outside the protocol trust boundary. Put discovery and package resolution behind lifecycle-specific schemas, move demographic package execution readback to `targeting_resolution.demographics` before its 3.2 release, deprecate targeting-like product filters, add migration guidance and conformance coverage, and retain exact-only booked package execution.

Update the buyer skill, Addie knowledge, and buyer learning modules to teach structured-first request decomposition and targeting-resolution review. Live training-agent support follows the generated 3.2 beta SDKs under issue #6199.
