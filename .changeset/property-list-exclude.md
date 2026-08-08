---
"adcontextprotocol": minor
---

Add `property_list_exclude` to the targeting overlay: a reference to a property list whose properties must not carry the buyer's ads, for brand-safety do-not-run lists (apps and sites). Mirrors `collection_list_exclude` and reuses `property-list-ref.json`. Exclude wins on overlap with `property_list` and applies regardless of the product's `property_targeting_allowed` flag. Sellers declare support via the property/collection list entries in the `get_adcp_capabilities` targeting table.
