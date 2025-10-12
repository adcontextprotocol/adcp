# Generative Creatives in sync_creatives

## Overview

This spec adds support for AI-generated creatives directly through `sync_creatives`, eliminating the need for separate `build_creative` and `preview_creative` tasks. Formats themselves define what inputs they accept (static assets, generation prompts, webhooks, etc.).

## Key Design Principles

1. **Input type = Format type** - Different formats for different input methods (static, generative, webhook, feed)
2. **Everything is an asset** - No distinction between "fields" and "assets"; brand_card and text prompts are asset types
3. **Previews in response** - Generative creatives return preview URLs directly in sync_creatives response
4. **Conversational approval** - Use context_id to approve or refine creatives

## Schema Changes

### New Asset Types

Added to asset type enums:
- `brand_card` - Brand context object with URL, colors, fonts, tone
- `url` - URL asset type (was missing)

### Updated Schemas

1. **`/schemas/v1/core/asset-type.json`**
   - Added `brand_card` and `url` to type enum

2. **`/schemas/v1/core/creative-asset.json`**
   - Changed `format` → `format_id`
   - Replaced flat structure with `assets` object (keyed by asset_role)
   - Added `inputs` array for preview contexts
   - Each asset has `asset_type` and type-specific properties

3. **`/schemas/v1/core/format.json`**
   - Added `description`, `preview_image`, `example_url` for discoverability
   - Added `brand_card` to asset_type enums

4. **`/schemas/v1/media-buy/sync-creatives-response.json`**
   - Added `previews` array to results
   - Added `interactive_url` and `expires_at` for preview management

5. **`/schemas/v1/media-buy/sync-creatives-approval-request.json`** (NEW)
   - Schema for approving or refining generative creatives
   - Uses `context_id` to continue conversation
   - `approve` array for creative_ids to save
   - `refine` array for creatives to regenerate with new prompts

## Workflow Examples

### Example 1: Static Asset Upload

```json
{
  "creatives": [
    {
      "creative_id": "banner_001",
      "format_id": "display_300x250_static",
      "name": "Summer Sale Banner",
      "assets": {
        "brand_context": {
          "asset_type": "brand_card",
          "url": "https://example.com"
        },
        "banner_image": {
          "asset_type": "image",
          "url": "https://cdn.example.com/banner.jpg",
          "width": 300,
          "height": 250
        }
      }
    }
  ]
}
```

Response: `status: "completed"` (immediate)

### Example 2: Generative Creative

```json
{
  "creatives": [
    {
      "creative_id": "banner_002",
      "format_id": "display_300x250_generative",
      "name": "AI Generated Banner",
      "assets": {
        "brand_context": {
          "asset_type": "brand_card",
          "url": "https://example.com",
          "colors": {
            "primary": "#FF6B35",
            "secondary": "#004E89"
          }
        },
        "generation_prompt": {
          "asset_type": "text",
          "content": "Create a summer sale banner with beach vibes"
        }
      },
      "inputs": [
        {"name": "Desktop", "macros": {"DEVICE_TYPE": "desktop"}},
        {"name": "Mobile", "macros": {"DEVICE_TYPE": "mobile"}}
      ]
    }
  ]
}
```

Response:
```json
{
  "status": "completed",
  "context_id": "ctx_abc123",
  "results": [
    {
      "creative_id": "banner_002",
      "action": "generated",
      "status": "pending_review",
      "previews": [
        {
          "preview_url": "https://pub.com/preview/abc/desktop",
          "input": {
            "name": "Desktop",
            "macros": {"DEVICE_TYPE": "desktop"}
          }
        },
        {
          "preview_url": "https://pub.com/preview/abc/mobile",
          "input": {
            "name": "Mobile",
            "macros": {"DEVICE_TYPE": "mobile"}
          }
        }
      ],
      "interactive_url": "https://pub.com/preview/abc/interactive",
      "expires_at": "2025-10-12T10:00:00Z"
    }
  ]
}
```

### Example 3: Approve Preview

```json
{
  "context_id": "ctx_abc123",
  "approve": ["banner_002"]
}
```

Response:
```json
{
  "status": "completed",
  "results": [
    {
      "creative_id": "banner_002",
      "action": "created",
      "status": "approved",
      "platform_id": "plt_456"
    }
  ]
}
```

### Example 4: Refine and Regenerate

```json
{
  "context_id": "ctx_abc123",
  "refine": [
    {
      "creative_id": "banner_002",
      "assets": {
        "generation_prompt": {
          "asset_type": "text",
          "content": "Make it more vibrant with a stronger CTA button"
        }
      }
    }
  ]
}
```

Response: New previews with updated creative

## Format Types

Publishers can offer different format types based on input methods:

### Static Formats
```json
{
  "format_id": "display_300x250_static",
  "name": "Display Banner 300x250 - Static Image",
  "description": "Upload your pre-made 300x250 banner image",
  "type": "display",
  "assets_required": [
    {
      "asset_id": "brand_context",
      "asset_type": "brand_card",
      "required": true
    },
    {
      "asset_id": "banner_image",
      "asset_type": "image",
      "required": true,
      "requirements": {
        "dimensions": {"width": 300, "height": 250}
      }
    }
  ]
}
```

### Generative Formats
```json
{
  "format_id": "display_300x250_generative",
  "name": "Display Banner 300x250 - AI Generated",
  "description": "Generate custom banners using AI from your brand card and prompt",
  "type": "display",
  "preview_image": "https://pub.com/format-previews/display_300x250_gen.png",
  "example_url": "https://pub.com/format-showcase/generative-display",
  "assets_required": [
    {
      "asset_id": "brand_context",
      "asset_type": "brand_card",
      "required": true
    },
    {
      "asset_id": "generation_prompt",
      "asset_type": "text",
      "required": true
    }
  ]
}
```

### Dynamic Generative Formats
```json
{
  "format_id": "audio_host_read_30s_dynamic",
  "name": "Dynamic AI Host Read 30s",
  "description": "AI-generated host reads that adapt to podcast context in real-time",
  "type": "audio",
  "assets_required": [
    {
      "asset_id": "brand_context",
      "asset_type": "brand_card",
      "required": true
    },
    {
      "asset_id": "generation_prompt",
      "asset_type": "text",
      "required": true
    }
  ]
}
```

Note: Dynamic formats generate content per-impression. When approved, they save the generation instructions, not a static asset.

## Implementation Notes

### For Publishers

1. **Format Discovery**: Expose format capabilities through `list_creative_formats`
2. **Creative Agent Integration**:
   - Receive sync_creatives with generative format
   - Call internal/external creative agent
   - Return preview URLs in response
3. **Preview Management**: Host preview URLs that render HTML pages
4. **Approval Flow**: Handle approval/refine requests using context_id

### For Buyers

1. **Format Selection**: Browse available formats, filter by capabilities
2. **Asset Preparation**: Provide assets matching format requirements
3. **Preview Review**: Review generated previews before approval
4. **Conversational Refinement**: Iterate with new prompts until satisfied

## Migration Path

### Deprecated Tasks
- `build_creative` - Use `sync_creatives` with generative format instead
- `preview_creative` - Previews now included in sync_creatives response

### Backward Compatibility
Old creative-asset schema (with `format`, `media_url`, `snippet`) should continue to work during transition period, but new implementations should use the asset-based model.

## Benefits

1. **Simpler workflow** - One task instead of three (build → preview → sync)
2. **Format clarity** - Input method is explicit in format_id
3. **Publisher flexibility** - Each publisher decides which input methods to support
4. **Unified model** - Same structure for static, generative, and dynamic creatives
5. **Better discoverability** - Formats are self-documenting with descriptions and examples
