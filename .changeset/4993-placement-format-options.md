---
"adcontextprotocol": minor
---

spec(3.1): clarify publisher-scoped placements and product format-option selectors.

Adds public placement catalog support in `adagents.json`, keeps seller-private routing fields out of public placement schemas, and introduces structured publisher-scoped `placement_refs` for creative assignment. Product placement IDs remain publisher-scoped; omitted `publisher_domain` is only a legacy single-publisher fallback.

Renames the beta buy-side canonical-format selector from `capability_*` to `format_option_*`. `FormatOptionRef` now selects publisher-catalog-backed options by `{scope: "publisher", publisher_domain, format_option_id}` and product-local options by `{scope: "product", format_option_id}` in the package's target product context. Pre-GA `capability_ids` / `capability_id` request fields are rejected instead of silently accepted.
