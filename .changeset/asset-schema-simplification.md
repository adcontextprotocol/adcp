---
"adcontextprotocol": major
---

BREAKING: Simplify asset schema architecture by separating payload from requirements

**Breaking Changes:**

1. **Removed `asset_type` field from creative manifest wire format**
   - Asset payloads no longer include redundant type information
   - Asset types are determined by format specification, not declared in manifest
   - Validation is format-aware using `asset_id` lookup

2. **Deleted `/creative/asset-types/*.json` individual schemas**
   - 11 duplicate schema files removed (image, video, audio, vast, daast, text, url, html, css, javascript, webhook)
   - Asset type registry now references `/core/assets/` schemas directly
   - Schema path changed: `/creative/asset-types/image.json` → `/core/assets/image-asset.json`

3. **Removed constraint fields from core asset payloads**
   - `vast-asset.json`: Removed `max_wrapper_depth` (format constraint, not payload data)
   - `text-asset.json`: Removed `max_length` (format constraint, not payload data)
   - `webhook-asset.json`: Removed `fallback_required` (format requirement, not asset property)
   - Constraint fields belong in format specification `requirements`, not asset schemas

**Why These Changes:**

- **Format-aware validation**: Creative manifests are always validated in the context of their format specification. The format already defines what type each `asset_id` should be, making `asset_type` in the payload redundant.
- **Single source of truth**: Each asset type now defined once in `/core/assets/`, eliminating 1,797 lines of duplicate code.
- **Clear separation of concerns**: Payload schemas describe data structure; format specifications describe constraints and requirements.
- **Reduced confusion**: No more wondering which schema to reference or where to put constraints.

**Migration Guide:**

### Code Changes

```diff
// Schema references
- const schema = await fetch('/schemas/v1/creative/asset-types/image.json')
+ const schema = await fetch('/schemas/v1/core/assets/image-asset.json')

// Creative manifest structure (removed asset_type)
{
  "assets": {
    "banner_image": {
-     "asset_type": "image",
      "url": "https://cdn.example.com/banner.jpg",
      "width": 300,
      "height": 250
    }
  }
}

// Validation changes - now format-aware
- // Old: Standalone asset validation
- validate(assetPayload, imageAssetSchema)

+ // New: Format-aware validation
+ const format = await fetchFormat(manifest.format_id)
+ const assetRequirement = format.assets_required.find(a => a.asset_id === assetId)
+ const assetSchema = await fetchAssetSchema(assetRequirement.asset_type)
+ validate(assetPayload, assetSchema)
```

### Validation Flow

1. Read `format_id` from creative manifest
2. Fetch format specification from format registry
3. For each asset in manifest:
   - Look up `asset_id` in format's `assets_required`
   - If not found → error "unknown asset_id"
   - Get `asset_type` from format specification
   - Validate asset payload against that asset type's schema
4. Check all required assets are present
5. Validate type-specific constraints from format `requirements`

### Constraint Migration

Constraints moved from asset schemas to format specification `requirements` field:

```diff
// Format specification assets_required
{
  "asset_id": "video_file",
  "asset_type": "video",
  "required": true,
  "requirements": {
    "width": 1920,
    "height": 1080,
    "duration_ms": 15000,
+   "max_file_size_bytes": 10485760,
+   "acceptable_codecs": ["h264", "h265"]
  }
}
```

These constraints are validated against asset payloads but are not part of the payload schema itself.
