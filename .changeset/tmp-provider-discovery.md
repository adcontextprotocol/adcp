---
"adcontextprotocol": minor
---

feat: deprecate AXE fields, add TMP provider discovery, activation keys, and lightweight context match

Marks `axe_include_segment`, `axe_exclude_segment`, and `required_axe_integrations` as deprecated in favor of TMP. Adds `trusted_match` filter to product-filters for filtering by TMP provider + match type. Adds `providers` array to the product `trusted_match` object so publishers can declare which TMP providers are integrated per product. Adds `trusted_match` to the `fields` enum on get-products-request. Adds `activation_key` to package, available-package, and offer schemas — a short, ad-server-safe key for GAM targeting that avoids exposing full package IDs in page markup. Removes `available_packages` from context match requests — providers use synced package metadata instead of receiving it per-request. Optional `package_ids` narrows the set when needed.
