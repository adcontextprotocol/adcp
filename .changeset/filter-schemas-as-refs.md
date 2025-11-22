---
"adcontextprotocol": patch
---

Extract filter objects into separate schema files for better type generation.

**Schema Changes:**
- Created `product-filters.json` core schema for `get_products` filters
- Created `creative-filters.json` core schema for `list_creatives` filters
- Created `signal-filters.json` core schema for `get_signals` filters
- Updated request schemas to use `$ref` instead of inline filter definitions

**Benefits:**
- Type generators can now create proper `ProductFilters`, `CreativeFilters`, and `SignalFilters` classes
- Enables direct object instantiation: `GetProductsRequest(filters=ProductFilters(delivery_type="guaranteed"))`
- Better IDE autocomplete and type checking for filter parameters
- Single source of truth for each filter type
- Consistent with other AdCP core object patterns

**Migration:**
No breaking changes - filter structures remain identical, just moved to separate schema files. Existing code continues to work without modification.
