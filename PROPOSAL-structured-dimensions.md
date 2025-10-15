# Proposal: Structured Dimensions and Multi-Output Preview Support

**Status**: Draft
**Type**: Breaking Change (Major Version)
**Impact**: Format schema, preview rendering, display/dooh/native formats
**Version Target**: v2.0.0

## Problem Statement

### 1. Unstructured Dimensions Field

Display ad dimensions are fundamental metadata that determine:
- Where ads can be placed
- How DSPs filter inventory
- How previews should be rendered
- Billing and pricing tiers
- Format selection logic

**Current approach** requires string parsing:
```json
{
  "dimensions": "300x250"
}
```

This forces every implementation to:
- Parse requirement strings like "300x250"
- Handle inconsistent formatting (300x250 vs 300 x 250 vs width:300,height:250)
- Have no schema validation for critical metadata
- Re-implement the same parsing logic across agents

**Current workaround**: The bandaid fix for preview rendering manually parses dimension strings. This works but shouldn't be necessary.

### 2. Multi-Output Preview Rendering

Many format types produce multiple rendered outputs:
- **Companion ads**: Video + display banner
- **Multi-placement ads**: Multiple sizes from one creative
- **Adaptive formats**: Desktop + mobile + tablet variants
- **Complex DOOH**: Multiple screens in a venue

**Current preview schema returns single preview per variant**, with no way to represent:
- Multiple simultaneous rendered outputs
- Relationships between companion pieces
- Different preview contexts (desktop/mobile/tablet)

This means implementations can't properly preview complex formats without custom extensions.

## Proposed Solution

### Part 1: Structured `render_dimensions` Field

Add a first-class structured field to the Format schema for formats with visual rendering (display, dooh, native):

```json
{
  "render_dimensions": {
    "width": 300,
    "height": 250,
    "responsive": {
      "width": false,
      "height": false
    },
    "unit": "px"
  }
}
```

**Schema definition**:
```json
{
  "render_dimensions": {
    "type": "object",
    "description": "Structured rendering dimensions for visual formats (display, dooh, native). Required for formats with fixed dimensions.",
    "properties": {
      "width": {
        "type": "number",
        "minimum": 0,
        "description": "Rendered width in specified units"
      },
      "height": {
        "type": "number",
        "minimum": 0,
        "description": "Rendered height in specified units"
      },
      "min_width": {
        "type": "number",
        "minimum": 0,
        "description": "Minimum width for responsive formats"
      },
      "min_height": {
        "type": "number",
        "minimum": 0,
        "description": "Minimum height for responsive formats"
      },
      "max_width": {
        "type": "number",
        "minimum": 0,
        "description": "Maximum width for responsive formats"
      },
      "max_height": {
        "type": "number",
        "minimum": 0,
        "description": "Maximum height for responsive formats"
      },
      "responsive": {
        "type": "object",
        "description": "Indicates which dimensions are responsive/fluid",
        "properties": {
          "width": {
            "type": "boolean",
            "description": "Whether width is responsive/fluid"
          },
          "height": {
            "type": "boolean",
            "description": "Whether height is responsive/fluid"
          }
        },
        "required": ["width", "height"]
      },
      "aspect_ratio": {
        "type": "string",
        "description": "Fixed aspect ratio constraint (e.g., '16:9', '4:3', '1:1')",
        "pattern": "^\\d+:\\d+$"
      },
      "unit": {
        "type": "string",
        "enum": ["px", "dp", "inches", "cm"],
        "default": "px",
        "description": "Unit of measurement for dimensions"
      }
    },
    "required": ["unit"],
    "additionalProperties": false
  }
}
```

**When to use each field**:

- **Fixed dimensions** (most display ads):
  ```json
  {
    "width": 300,
    "height": 250,
    "responsive": {"width": false, "height": false},
    "unit": "px"
  }
  ```

- **Responsive with min/max** (fluid banners):
  ```json
  {
    "min_width": 300,
    "max_width": 970,
    "height": 250,
    "responsive": {"width": true, "height": false},
    "unit": "px"
  }
  ```

- **Aspect ratio constrained** (native, some DOOH):
  ```json
  {
    "aspect_ratio": "16:9",
    "min_width": 300,
    "responsive": {"width": true, "height": true},
    "unit": "px"
  }
  ```

- **Physical dimensions** (DOOH):
  ```json
  {
    "width": 48,
    "height": 14,
    "responsive": {"width": false, "height": false},
    "unit": "inches"
  }
  ```

### Part 2: Multi-Output Preview Support

Update `preview-creative-response.json` to support multiple rendered outputs per preview variant:

```json
{
  "previews": [
    {
      "preview_id": "variant_1_default",
      "outputs": [
        {
          "output_id": "primary_video",
          "preview_url": "https://...",
          "output_role": "primary",
          "format_id": {
            "agent_url": "https://creative.adcontextprotocol.org",
            "id": "video_standard_30s"
          },
          "hints": {
            "primary_media_type": "video",
            "estimated_dimensions": {
              "width": 1920,
              "height": 1080
            },
            "estimated_duration_seconds": 30
          }
        },
        {
          "output_id": "companion_banner",
          "preview_url": "https://...",
          "output_role": "companion",
          "format_id": {
            "agent_url": "https://creative.adcontextprotocol.org",
            "id": "display_300x250"
          },
          "hints": {
            "primary_media_type": "image",
            "estimated_dimensions": {
              "width": 300,
              "height": 250
            }
          }
        }
      ],
      "input": {
        "name": "Default variant",
        "macros": {}
      }
    }
  ]
}
```

**Key changes**:
1. **`outputs` array**: Replaces single `preview_url` with array of output objects
2. **`output_id`**: Unique identifier for each rendered piece
3. **`output_role`**: Semantic role (primary, companion, mobile_variant, desktop_variant, etc.)
4. **`format_id` per output**: Each output specifies its format (enables proper dimension lookup)

**Backward compatibility**: Single-output formats can return one item in `outputs` array.

### Part 3: Format Type Validation

Add validation rules to Format schema:

```json
{
  "allOf": [
    {
      "if": {
        "properties": {
          "type": {"enum": ["display", "dooh", "native"]}
        }
      },
      "then": {
        "required": ["render_dimensions"]
      }
    }
  ]
}
```

This enforces that visual formats MUST specify structured dimensions.

## Benefits

### 1. Eliminates Parsing Ambiguity
- No more string parsing implementations
- Schema-validated dimensions
- Consistent handling across all agents

### 2. Enables Proper Preview Rendering
- Preview systems can reliably extract dimensions
- No custom parsing logic needed
- Supports responsive and fixed dimensions equally

### 3. Supports Complex Preview Scenarios
- Companion ads (video + banner)
- Multi-placement formats
- Adaptive rendering (mobile/desktop/tablet)
- Multi-screen DOOH installations

### 4. Better Format Filtering
DSPs and platforms can filter by:
```json
{
  "filters": {
    "min_width": 300,
    "max_width": 970,
    "aspect_ratio": "16:9"
  }
}
```

### 5. Industry Standard Alignment
- DOOH can use physical units (inches, cm)
- Mobile can use density-independent pixels (dp)
- Web uses CSS pixels (px)

## Migration Path

### Phase 1: Add New Fields (Non-Breaking)
1. Add `render_dimensions` as optional field to Format schema
2. Update standard formats to include both `dimensions` (string) and `render_dimensions` (object)
3. Update documentation to recommend `render_dimensions`

### Phase 2: Deprecation Period (6 months)
1. Mark string `dimensions` field as deprecated
2. Creative agents log warnings when formats lack `render_dimensions`
3. Preview implementations prefer `render_dimensions` but fall back to parsing `dimensions`

### Phase 3: v2.0.0 Breaking Change
1. Remove string `dimensions` field entirely
2. Make `render_dimensions` required for display/dooh/native format types
3. Update all standard formats to use only structured dimensions
4. Update preview schema to multi-output model

## Implementation Checklist

- [ ] Update `/schemas/v1/core/format.json` with `render_dimensions` field
- [ ] Update all standard display formats in `/schemas/v1/standard-formats/display/`
- [ ] Update all DOOH formats with physical dimension support
- [ ] Update `/schemas/v1/creative/preview-creative-response.json` for multi-output
- [ ] Create migration guide in `/docs/reference/versioning.md`
- [ ] Update format discovery documentation
- [ ] Update preview rendering documentation
- [ ] Add validation tests for format dimensions
- [ ] Update schema registry to v2.0.0
- [ ] Update all format examples in documentation

## Open Questions

### 1. Should we support transcoding hints?

For video/audio formats, should `render_dimensions` include transcoding metadata?

```json
{
  "render_dimensions": {
    "width": 1920,
    "height": 1080,
    "transcoding": {
      "variants": [
        {"width": 1920, "height": 1080, "bitrate": "5000kbps"},
        {"width": 1280, "height": 720, "bitrate": "2500kbps"},
        {"width": 640, "height": 360, "bitrate": "1000kbps"}
      ]
    }
  }
}
```

**Recommendation**: Not in initial implementation. Transcoding is delivery concern, not format definition. Keep `render_dimensions` focused on what gets rendered, not how it's encoded.

### 2. How to handle truly dynamic dimensions?

Some native formats have no fixed dimensions (e.g., in-feed social ads). Options:

**Option A**: Omit `render_dimensions` entirely for fully fluid formats
**Option B**: Use aspect ratio only:
```json
{
  "render_dimensions": {
    "aspect_ratio": "1:1",
    "responsive": {"width": true, "height": true},
    "unit": "px"
  }
}
```

**Recommendation**: Option B - always include `render_dimensions` with at least aspect ratio and responsive flags. Enables better format selection.

### 3. Preview rendering for generative formats?

Formats with `output_format_ids` generate other formats dynamically. How should previews work?

**Current approach**: Preview shows the input format (e.g., brand manifest + message)
**Alternative**: Preview shows example outputs in each target format

**Recommendation**: Keep current approach. Generative format previews show the input interface. Output format previews are handled separately via `preview_creative` on the generated manifests.

## Example: Updated Display Format

**Before** (`display_300x250.json`):
```json
{
  "format_id": "display_300x250",
  "type": "display",
  "name": "Medium Rectangle Banner",
  "dimensions": "300x250",
  "assets_required": [...]
}
```

**After** (v2.0.0):
```json
{
  "format_id": "display_300x250",
  "type": "display",
  "name": "Medium Rectangle Banner",
  "render_dimensions": {
    "width": 300,
    "height": 250,
    "responsive": {
      "width": false,
      "height": false
    },
    "unit": "px"
  },
  "assets_required": [...]
}
```

## Example: Responsive Native Format

```json
{
  "format_id": "native_responsive",
  "type": "native",
  "name": "Responsive Native Ad",
  "render_dimensions": {
    "aspect_ratio": "16:9",
    "min_width": 300,
    "responsive": {
      "width": true,
      "height": true
    },
    "unit": "px"
  },
  "assets_required": [...]
}
```

## Example: DOOH Physical Billboard

```json
{
  "format_id": "dooh_billboard_48x14",
  "type": "dooh",
  "name": "Standard Billboard",
  "render_dimensions": {
    "width": 48,
    "height": 14,
    "responsive": {
      "width": false,
      "height": false
    },
    "unit": "inches"
  },
  "assets_required": [...]
}
```

## Next Steps

1. **Gather feedback** on proposal structure and fields
2. **Validate** with existing preview rendering implementations
3. **Prototype** multi-output preview support
4. **Implement** in stages with proper deprecation timeline
5. **Document** migration path for existing implementations

## Related Documentation

- [Format Schema Reference](/schemas/v1/core/format.json)
- [Preview Creative Task](/docs/creative/task-reference/preview_creative.md)
- [Display Format Guide](/docs/creative/channels/display.md)
- [Schema Versioning Guidelines](/CLAUDE.md#schema-versioning-workflow)
