---
"adcontextprotocol": minor
---

Add explicit discriminator fields to discriminated union types for better TypeScript type generation

**Schema Changes:**

- **product.json**: Add `selection_type` discriminator ("by_id" | "by_tag") to `publisher_properties` items
- **adagents.json**: Add `authorization_type` discriminator ("property_ids" | "property_tags" | "inline_properties" | "publisher_properties") to `authorized_agents` items, and nested `selection_type` discriminator to `publisher_properties` arrays
- **format.json**: Add `item_type` discriminator ("individual" | "repeatable_group") to `assets_required` items

**Rationale:**

Without explicit discriminators, TypeScript generators produce poor types - either massive unions with broken type narrowing or generic index signatures. With discriminators, TypeScript can properly narrow types and provide excellent IDE autocomplete.

**Migration Guide:**

All schema changes are **additive** - new required discriminator fields are added to existing structures:

**Product Schema (`publisher_properties`):**
```json
// Before
{
  "publisher_domain": "cnn.com",
  "property_ids": ["cnn_ctv_app"]
}

// After
{
  "publisher_domain": "cnn.com",
  "selection_type": "by_id",
  "property_ids": ["cnn_ctv_app"]
}
```

**AdAgents Schema (`authorized_agents`):**
```json
// Before
{
  "url": "https://agent.com",
  "authorized_for": "All inventory",
  "property_ids": ["site_123"]
}

// After
{
  "url": "https://agent.com",
  "authorized_for": "All inventory",
  "authorization_type": "property_ids",
  "property_ids": ["site_123"]
}
```

**Format Schema (`assets_required`):**
```json
// Before
{
  "asset_group_id": "product",
  "repeatable": true,
  "min_count": 3,
  "max_count": 10,
  "assets": [...]
}

// After
{
  "item_type": "repeatable_group",
  "asset_group_id": "product",
  "min_count": 3,
  "max_count": 10,
  "assets": [...]
}
```

Note: The `repeatable` field has been removed from format.json as it's redundant with the `item_type` discriminator.

**Validation Impact:**

Schemas now have stricter validation - implementations must include the discriminator fields. This ensures type safety and eliminates ambiguity when parsing union types.
