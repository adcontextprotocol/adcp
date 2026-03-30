---
"adcontextprotocol": minor
---

feat: deprecate AXE fields, add TMP provider discovery, property_rid, typed artifacts, lightweight context match

Marks `axe_include_segment`, `axe_exclude_segment`, and `required_axe_integrations` as deprecated in favor of TMP. Adds `trusted_match` filter to product-filters for filtering by TMP provider + match type. Adds `providers` array to the product `trusted_match` object so publishers can declare which TMP providers are integrated per product. Adds `trusted_match` to the `fields` enum on get-products-request. Removes `available_packages` from context match requests — providers use synced package metadata instead of receiving it per-request. Optional `package_ids` narrows the set when needed. Adds `property_rid` (UUID v7 from property catalog) as the primary identifier on context match requests, with `property_id` optional for logging. Replaces plain-string artifacts with typed objects (`url`, `url_hash`, `eidr`, `gracenote`, `rss_guid`, `isbn`, `custom`) so buyers can resolve content via public registries. Removes top-level `url_hash` field (now an artifact type).
