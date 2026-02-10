---
"adcontextprotocol": major
---

Standardize cursor-based pagination across all list operations.

### Breaking Changes

- **`list_creatives`**: Replace offset-based `limit`/`offset` with cursor-based `pagination` object
- **`tasks_list`**: Replace offset-based `limit`/`offset` with cursor-based `pagination` object
- **`list_property_lists`**: Move top-level `max_results`/`cursor` into nested `pagination` object
- **`get_property_list`**: Move top-level `max_results`/`cursor` into nested `pagination` object
- **`get_media_buy_artifacts`**: Move top-level `limit`/`cursor` into nested `pagination` object

### Non-Breaking Changes

- Add shared `pagination-request.json` and `pagination-response.json` schemas to `core/`
- Add optional `pagination` support to `list_accounts`, `get_products`, `list_creative_formats`, `list_content_standards`, and `get_signals`
- Update documentation for all affected operations

All list operations now use a consistent pattern: `pagination.max_results` + `pagination.cursor` in requests, `pagination.has_more` + `pagination.cursor` + optional `pagination.total_count` in responses.
