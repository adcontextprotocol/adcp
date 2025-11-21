---
"adcontextprotocol": patch
---

Extract duplicated property ID and tag patterns into reusable core schemas.

**New schemas:**
- `property-id.json` - Single source of truth for property identifier validation
- `property-tag.json` - Single source of truth for property tag validation

**Updated schemas:**
- `publisher-property-selector.json` - Now references shared property-id and property-tag schemas
- `adagents.json` - Now references shared property-id and property-tag schemas
- `property.json` - Now references shared property-id and property-tag schemas for property_id and tags fields

**Benefits:**
- Eliminates inline pattern duplication across multiple schemas
- SDK generators now produce single types for property IDs and tags instead of multiple incompatible types
- Single source of truth for validation rules - changes apply everywhere
- Clearer semantic meaning with explicit type names
- Easier to maintain and evolve constraints in the future

**Breaking change:** No - validation behavior is identical, this is a refactoring only.
