---
"adcontextprotocol": minor
---

Add template formats with dimension parameters to eliminate format explosion for dimension variants.

**Problem:** Publishers supporting hundreds of placement sizes would need separate format definitions for each dimension (300x250, 728x90, 970x250, etc.), creating unmanageable format catalogs.

**Solution:** Template formats accept dimension/duration parameters in the format_id object. Format definitions use `parameters_from_format_id` flags to indicate where parameters are used, making it clear how dimensions flow from format_id to renders and assets.

**Key Changes:**

1. **Format ID Schema** - Added optional dimension and duration fields
   - `width`, `height` (integers) - Pixel dimensions for visual formats (display, DOOH, native)
   - `duration_ms` (number) - Duration in milliseconds for time-based formats (video, audio)
   - Fields are optional - omitting them references template formats without parameters
   - Including them creates parameterized format IDs
   - All dimensions are pixels (no unit field needed)

2. **Format Schema** - Added capability and reference indicators
   - `accepts_parameters` - Array listing which parameters format accepts (["dimensions"], ["duration"], or ["dimensions", "duration"])
   - `renders[].parameters_from_format_id` - Render parameters come from format_id
   - `requirements.parameters_from_format_id` - Asset parameters must match format_id
   - Consistent naming: accepts_parameters → parameters_from_format_id

3. **Creative Manifest Schema** - Updated format_id description
   - Creatives specify dimensions/duration in format_id object
   - Parameterized format_ids enable deduplication and caching (same dimensions = same ID)
   - Template formats accept any parameters, concrete formats have fixed dimensions

4. **Placement Schema** - Simplified constraint model
   - Placements list template format_ids without parameters (accept any dimensions)
   - OR list parameterized format_ids (constrain exact dimensions)
   - Removed complex format_constraints object (not needed)

**Benefits:**
- ✅ Scalable to unlimited format variants without explosion
- ✅ Parameterized format IDs enable caching and deduplication
- ✅ Type-safe (dimensions are integers in pixels, not encoded strings)
- ✅ Creatives are self-contained with dimensions in format_id
- ✅ Publisher control via template vs parameterized format_ids
- ✅ Backward compatible - formats without optional fields unchanged
- ✅ Matches industry reality (format type + dimensions = concrete format)

**Examples:**

**Template format definition (accepts any dimensions):**
```json
{
  "format_id": {"agent_url": "...", "id": "display_static"},
  "accepts_parameters": ["dimensions"],
  "renders": [
    {
      "role": "primary",
      "parameters_from_format_id": true
    }
  ],
  "assets_required": [
    {
      "asset_id": "banner_image",
      "asset_type": "image",
      "requirements": {
        "parameters_from_format_id": true
      }
    }
  ]
}
```

**Creative with parameterized format_id:**
```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "display_static",
    "width": 300,
    "height": 250,
    "unit": "px"
  },
  "assets": {...}
}
```

**Placement constraints (Option 1 - Template):**
```json
{
  "format_ids": [
    {"agent_url": "...", "id": "display_static"}  // Accepts any dimensions
  ]
}
```

**Placement constraints (Option 2 - Parameterized):**
```json
{
  "format_ids": [
    {"agent_url": "...", "id": "display_static", "width": 300, "height": 250},
    {"agent_url": "...", "id": "display_static", "width": 728, "height": 90}
    // Accepts only these exact dimensions
  ]
}
```

**Documentation:**
- New comprehensive guide at `/docs/creative/template-format-ids.mdx`
- Examples for display, video, audio, and DOOH use cases
- All dimensions in pixels (integers) - no unit field needed
- Migration guidance from concrete to template formats
- Validation and matching logic documentation
