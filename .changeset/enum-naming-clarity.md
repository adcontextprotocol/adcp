---
"adcontextprotocol": minor
---

Consolidate and rename enum types to eliminate naming collisions

## Problem

Type generators (Python, TypeScript, Go) produced collisions when the same enum name appeared in different schemas:

- `AssetType` collided across 3 different schemas with overlapping value sets
- `Type` field name used for both asset content types and format categories
- Filtering contexts used incomplete subsets rather than full enum

This caused downstream issues:
- Python codegen exported first-alphabetically enum, hiding others
- TypeScript generators produced `Type1`, `Type2` aliases
- Developers needed internal imports to access correct types

## Changes

**New enum files**:
- `/schemas/v1/enums/asset-content-type.json` - Asset content types (image, video, html, javascript, vast, daast, text, markdown, css, url, webhook, promoted_offerings, audio)
- `/schemas/v1/enums/format-category.json` - Format categories (audio, video, display, native, dooh, rich_media, universal)

**Removed**:
- `/schemas/v1/core/asset-type.json` - Orphaned schema (never referenced). Originally intended for format requirements but superseded by inline asset definitions in format.json. The enum values from this schema informed the new asset-content-type.json enum.

**Updated schemas**:
- `format.json`: `type` field now references `format-category.json`
- `format.json`: `asset_type` fields now reference `asset-content-type.json`
- `list-creative-formats-request.json`: All filter fields now use full enum references (no more artificial subsets)
- `brand-manifest.json`: `asset_type` now references full enum with documentation note about typical usage

## Wire Protocol Impact

**None** - This change only affects schema organization and type generation. The JSON wire format is unchanged, so all API calls remain compatible.

## SDK/Type Generation Impact

**Python**: Update imports from internal generated modules to stable exports:

```python
# Before
from adcp.types.stable import AssetType  # Actually got asset content types
from adcp.types.generated_poc.format import Type as FormatType  # Had to alias

# After
from adcp.types.stable import AssetContentType, FormatCategory
```

**TypeScript**: Update type imports:

```typescript
// Before
import { AssetType, Type } from './generated/types'  // Ambiguous

// After
import { AssetContentType, FormatCategory } from './generated/types'  // Clear
```

**Schema references**: If you're implementing validators, update `$ref` paths:

```json
// Before
{ "type": "string", "enum": ["image", "video", ...] }

// After
{ "$ref": "/schemas/v1/enums/asset-content-type.json" }
```

## Rationale

- **Type safety**: Generators produce clear, non-colliding type names
- **API flexibility**: Filters now accept full enum (no artificial restrictions)
- **Maintainability**: Single source of truth for each concept
- **Clarity**: Semantic names (`AssetContentType` vs `FormatCategory`) self-document

## Spec Policy

Going forward, AdCP follows strict enum naming rules documented in `/docs/spec-guidelines.md`:
- No reused enum names across different schemas
- Use semantic, domain-specific names
- Consolidate enums rather than creating subsets
- All enums in `/schemas/v1/enums/` directory
