---
"adcontextprotocol": major
---

Capabilities model cleanup for 3.0. Removes redundant boolean gates, makes table-stakes fields required, flattens geo targeting.

**Removed fields:**
- `media_buy.reporting` — reporting is implied by media_buy. Product-level `reporting_capabilities` (now required) is the source of truth.
- `features.content_standards`, `features.audience_targeting`, `features.conversion_tracking` — replaced by object presence: `media_buy.content_standards`, `media_buy.audience_targeting`, `media_buy.conversion_tracking`.
- `content_standards_detail` — renamed to `content_standards`.
- `execution.targeting.device_platform`, `device_type` — implied by media_buy support.
- `execution.targeting.audience_include`, `audience_exclude` — implied by audience_targeting object presence.
- `execution.trusted_match.supported` — object presence indicates support.
- `brand.identity` — implied by brand in supported_protocols.

**Required fields:**
- `reporting_capabilities` now required on every product.
- `account` and `media_buy.portfolio` now required when media_buy is in supported_protocols.

**Geo targeting:**
- Added `supported_geo_levels`, `supported_metro_systems`, `supported_postal_systems` flat arrays.
- Deprecated `geo_countries`, `geo_regions`, `geo_metros`, `geo_postal_areas` (will be removed in 4.0).
