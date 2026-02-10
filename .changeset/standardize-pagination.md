---
"adcontextprotocol": minor
---

Standardize cursor-based pagination across all list operations.

- Add shared `pagination-request.json` and `pagination-response.json` schemas to `core/`
- Migrate `list_creatives` and `tasks_list` from offset-based to cursor-based pagination
- Migrate `list_property_lists` and `get_property_list` pagination params from top-level to nested `pagination` object
- Add optional pagination support to `list_accounts`, `get_products`, `list_creative_formats`, `list_content_standards`, and `get_signals`
- Migrate `get_media_buy_artifacts` from top-level `limit`/`cursor` to nested `pagination` object
- Update documentation for all affected operations

All list operations now use a consistent pattern: `pagination.max_results` + `pagination.cursor` in requests, `pagination.has_more` + `pagination.cursor` + optional `pagination.total_count` in responses.
