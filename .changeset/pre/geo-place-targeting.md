---
"adcontextprotocol": minor
---

Add identifier-based named-place geographic targeting:

- `targeting_overlay.geo_places` and `geo_places_exclude` carry stable identifiers with country, system, place type, optional catalog version, and diagnostic labels.
- `get_adcp_capabilities` declares exact country/type pairs, accepted catalog versions, and a standard resolver for every collision-safe identifier system.
- `get_products.targeting_overlay` carries known place IDs so configured products, pricing, and forecasts reflect them; `required_overlay_support` and Product `overlay_support` declare collision-safe permission for place values selected later.
- Package status MUST echo persisted place overlays with the applied catalog version through the existing `targeting_overlay` contract.
- Resolver responses echo their normalized query, carry machine-verifiable disambiguation and lifecycle metadata, and support existing-ID refresh after catalog rollover.
- `PLACE_TARGET_UNAVAILABLE` provides a nonfatal, correctable read-path signal when a pinned target can no longer execute without silently changing geography.
- Create-time place overlays use deterministic `UNSUPPORTED_FEATURE`, `INVALID_REQUEST`, and `PRODUCT_UNAVAILABLE` dispositions while preserving the configured product's binding pricing contract.
- Place forecast and delivery breakdowns remain deferred; package echo is the interim configuration-audit path.

Refs #5588.
