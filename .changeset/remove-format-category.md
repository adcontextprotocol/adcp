---
"adcontextprotocol": major
---

Remove FormatCategory enum and `type` field from Format objects

The `format-category.json` enum, `type` field on Format, `format_types` filter on product-filters and creative-filters, and `type` filter on list-creative-formats-request have been removed.

**What to use instead:**
- To understand what a format requires: inspect the `assets` array
- To filter formats by content type: use the `asset_types` filter on `list_creative_formats`
- To filter products by channel: use the `channels` filter on `get_products`
- To filter by specific formats: use `format_ids`

**Breaking changes:**
- `format-category.json` enum deleted
- `type` property removed from `format.json`
- `format_types` removed from `product-filters.json` and `creative-filters.json`
- `type` filter removed from `list-creative-formats-request.json`
