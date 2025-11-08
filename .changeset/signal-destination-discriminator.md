---
"adcontextprotocol": minor
---

Add discriminator fields to multiple schemas for improved TypeScript type safety and reduced union signature complexity.

**Breaking Changes**: The following schemas now require discriminator fields:

**Signal Schemas:**
- `destination.json`: Added discriminator with `type: "platform"` or `type: "agent"`
- `deployment.json`: Added discriminator with `type: "platform"` or `type: "agent"`

**Creative Asset Schemas:**
- `sub-asset.json`: Added discriminator with `asset_kind: "media"` or `asset_kind: "text"`
- `vast-asset.json`: Added discriminator with `delivery_type: "url"` or `delivery_type: "inline"`
- `daast-asset.json`: Added discriminator with `delivery_type: "url"` or `delivery_type: "inline"`

**Preview Response Schemas:**
- `preview-render.json`: NEW schema extracting render object with proper `oneOf` discriminated union
- `preview-creative-response.json`: Refactored to use `$ref` to `preview-render.json` instead of inline `allOf`/`if`/`then` patterns

**Benefits:**
- Reduces TypeScript union signature count significantly (estimated ~45 to ~20)
- Enables proper discriminated unions in TypeScript across all schemas
- Eliminates broken index signature intersections from `allOf`/`if`/`then` patterns
- Improves IDE autocomplete and type checking
- Provides type-safe discrimination between variants
- Single source of truth for shared schema structures (DRY principle)
- 51% reduction in preview response schema size (380 → 188 lines)

**Migration Guide:**

### Signal Destinations and Deployments

**Before:**
```json
{
  "destinations": [{
    "platform": "the-trade-desk",
    "account": "agency-123"
  }]
}
```

**After:**
```json
{
  "destinations": [{
    "type": "platform",
    "platform": "the-trade-desk",
    "account": "agency-123"
  }]
}
```

For agent URLs:
```json
{
  "destinations": [{
    "type": "agent",
    "agent_url": "https://wonderstruck.salesagents.com"
  }]
}
```

### Sub-Assets

**Before:**
```json
{
  "asset_type": "headline",
  "asset_id": "main_headline",
  "content": "Premium Products"
}
```

**After:**
```json
{
  "asset_kind": "text",
  "asset_type": "headline",
  "asset_id": "main_headline",
  "content": "Premium Products"
}
```

For media assets:
```json
{
  "asset_kind": "media",
  "asset_type": "product_image",
  "asset_id": "hero_image",
  "content_uri": "https://cdn.example.com/image.jpg"
}
```

### VAST/DAAST Assets

**Before:**
```json
{
  "url": "https://vast.example.com/tag",
  "vast_version": "4.2"
}
```

**After:**
```json
{
  "delivery_type": "url",
  "url": "https://vast.example.com/tag",
  "vast_version": "4.2"
}
```

For inline content:
```json
{
  "delivery_type": "inline",
  "content": "<VAST version=\"4.2\">...</VAST>",
  "vast_version": "4.2"
}
```

### Preview Render Output Format

**Note:** The `output_format` discriminator already existed in the schema. This change improves TypeScript type generation by replacing `allOf`/`if`/`then` conditional logic with proper `oneOf` discriminated unions. **No API changes required** - responses remain identical.

**Schema pattern (existing behavior, better typing):**
```json
{
  "renders": [{
    "render_id": "primary",
    "output_format": "url",
    "preview_url": "https://...",
    "role": "primary"
  }]
}
```

The `output_format` field acts as a discriminator:
- `"url"` → only `preview_url` field present
- `"html"` → only `preview_html` field present
- `"both"` → both `preview_url` and `preview_html` fields present
