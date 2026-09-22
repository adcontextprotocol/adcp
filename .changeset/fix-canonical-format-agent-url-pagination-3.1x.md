---
"adcontextprotocol": patch
---

Canonicalize `format_ids[].agent_url` in the `get_products_pagination_integrity` storyboard: `https://compliance.adcontextprotocol.org` → `https://compliance.adcontextprotocol.org/`. `core/format-id.json` requires callers to canonicalize `agent_url` before treating two `format-id` values as the same, and `docs/reference/url-canonicalization.mdx` step 5 substitutes `/` for an empty path when an authority is present — so a schema-conformant seller emits the trailing slash and failed the storyboard's raw string comparison. Corrects all six occurrences (both seeded fixtures, both request filters, and the `field_contains` values on `wholesale_first_page` and `wholesale_terminal_page`). Partially addresses #7367; the runner-side canonicalization in `adcp-client` remains the general fix.
