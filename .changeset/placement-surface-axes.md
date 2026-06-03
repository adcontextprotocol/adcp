---
"adcontextprotocol": minor
---

Add `sponsored_placement_types` (retail media) and `social_placement_surfaces` (social) declarations to products and placements, plus matching `get_products.filters` discovery filters, mirroring the `video_placement_types` pattern. Both are seller-declared discovery metadata, not buyer gates. Retail values: `sponsored_search`, `sponsored_display`, `sponsored_native` (`sponsored_offsite` excluded — not catalog-keyed). Social values: `feed`, `stories`, `short_video`, `explore`, `search` (semantic surfaces, not platform brand names).
