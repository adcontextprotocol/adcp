---
"adcontextprotocol": minor
---

Refactor schemas to use $ref for shared type definitions

**New shared type:**
- `core/media-buy-features.json` - Shared definition for media-buy protocol features (inline_creative_management, property_list_filtering, content_standards)

**Breaking change:**
- `required_features` in product-filters.json changed from string array to object with boolean properties
  - Before: `["content_standards", "inline_creative_management"]`
  - After: `{ "content_standards": true, "inline_creative_management": true }`
- This aligns the filter format with the capabilities declaration format in `get_adcp_capabilities`

**Schema deduplication:**
- `get-adcp-capabilities-response.json`: `media_buy.features` now uses $ref to `core/media-buy-features.json`
- `product-filters.json`: `required_features` now uses $ref to `core/media-buy-features.json`
- `artifact.json`: `property_id` now uses $ref to `core/identifier.json`
- `artifact.json`: `format_id` now uses $ref to `core/format-id.json`

**Benefits:**
- Single source of truth for shared types
- Consistent validation across all usages
- Reduced schema maintenance burden
