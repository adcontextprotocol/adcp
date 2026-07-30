---
"adcontextprotocol": minor
---

Add identifier-based named-place geographic targeting:

- `targeting_overlay.geo_places` and `geo_places_exclude` carry stable identifiers with country, system, place type, optional catalog version, and diagnostic labels.
- `get_adcp_capabilities` declares exact country/type pairs, accepted catalog versions, and a standard resolver for every collision-safe identifier system.
- `get_products` adds place coverage and version-aware capability filters so buyers can discover support before creating a media buy.
- Package status MUST echo persisted place overlays with the applied catalog version through the existing `targeting_overlay` contract.
- Resolver responses echo their normalized query, carry machine-verifiable disambiguation and lifecycle metadata, and support existing-ID refresh after catalog rollover.
- `PLACE_TARGET_UNAVAILABLE` provides a nonfatal, correctable read-path signal when a pinned target can no longer execute without silently changing geography.
- Place forecast and delivery breakdowns remain deferred; package echo is the interim configuration-audit path.

Refs #5588.
