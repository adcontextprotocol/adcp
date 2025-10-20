---
title: build_creative
sidebar_position: 13
---

# build_creative

Transform or generate a creative manifest for a specific format. This task takes a source manifest (which may be minimal for pure generation) and produces a target manifest in the specified format.

**Key concept**: `build_creative` is fundamentally a **transformation** - it takes a creative manifest as input and produces a creative manifest as output. For pure generation (creating from scratch), the source manifest is minimal (just format and seed assets). For transformation (e.g., resizing, reformatting), the source is a complete creative.

For information about format IDs and how to reference formats, see [Creative Formats - Referencing Formats](../formats.md#referencing-formats).

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | No | Natural language instructions for the transformation or generation. For pure generation, this is the creative brief. For transformation, this provides guidance on how to adapt the source. |
| `source_manifest` | object | No | Source creative manifest to transform (see [Creative Manifest](/schemas/v1/core/creative-manifest.json)). For pure generation, this can be minimal (just format_id and any seed assets). For transformation (e.g., resizing, reformatting), this is the complete source creative. If omitted, creative agent may use defaults. |
| `target_format_id` | object | Yes | Format ID to generate. Object with `agent_url` and `id` fields. The format definition specifies whether output is manifest-based or code-based. |
| `promoted_offerings` | object | No | Complete offering specification for generative creatives - includes brand manifest, product selectors, inline offerings, and asset filters. Used as input context for generation. See [Promoted Offerings](/schemas/v1/core/promoted-offerings.json). |

## Use Cases

### Pure Generation (Creating from Scratch)

For pure generation, provide a minimal source manifest (or omit it) and use `message` and `promoted_offerings` to guide creation:

```json
{
  "message": "Create a banner promoting our winter sale with a warm, inviting feel",
  "target_format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "display_300x250"
  },
  "promoted_offerings": {
    "brand_manifest": {
      "url": "https://mybrand.com",
      "colors": {"primary": "#FF0000"}
    }
  }
}
```

### Transformation (Adapting Existing Creative)

For transformation, provide the complete source manifest:

```json
{
  "message": "Adapt this creative for mobile, making the text larger and CTA more prominent",
  "source_manifest": {
    "format_id": {
      "agent_url": "https://creative.adcontextprotocol.org",
      "id": "display_300x250"
    },
    "assets": {
      "banner_image": {
        "asset_type": "image",
        "url": "https://cdn.example.com/original-banner.png",
        "width": 300,
        "height": 250
      },
      "headline": {
        "asset_type": "text",
        "content": "Winter Sale - 50% Off"
      }
    }
  },
  "target_format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "display_mobile_320x50"
  }
}
```

### Format Resizing

Transform an existing creative to a different size:

```json
{
  "source_manifest": {
    "format_id": {
      "agent_url": "https://creative.adcontextprotocol.org",
      "id": "display_728x90"
    },
    "assets": { /* complete assets */ }
  },
  "target_format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "display_300x250"
  }
}
```

## Response Format

The response contains the transformed or generated creative manifest:

```json
{
  "creative_manifest": {
    "format_id": {
      "agent_url": "https://creative.adcontextprotocol.org",
      "id": "display_300x250"
    },
    "promoted_offering": "Winter Sale Collection",
    "assets": {
      "banner_image": {
        "asset_type": "image",
        "url": "https://cdn.example.com/generated-banner.png",
        "width": 300,
        "height": 250
      },
      "headline": {
        "asset_type": "text",
        "content": "50% Off Winter Sale"
      },
      "clickthrough_url": {
        "asset_type": "url",
        "url": "https://mybrand.com/winter-sale"
      }
    }
  }
}
```

### Field Descriptions

- **creative_manifest**: The complete creative manifest ready for use with `sync_creatives` or `preview_creative`
- **format_id**: The target format (matches `target_format_id` from request)
- **promoted_offering**: Product/offering being advertised (optional)
- **assets**: Map of asset IDs to actual asset content, matching the format's `assets_required` specification

## Workflow Integration

### Typical Generation Workflow

1. **Build**: Use `build_creative` to generate/transform the manifest
2. **Preview**: Use `preview_creative` to see how it renders (see [preview_creative](./preview_creative.md))
3. **Sync**: Use `sync_creatives` to traffic the finalized creative

```json
// Step 1: Build
{
  "message": "Create a display banner for our winter sale",
  "target_format_id": {"agent_url": "...", "id": "display_300x250"},
  "promoted_offerings": { /* brand and product data */ }
}

// Step 2: Preview (using the output manifest from step 1)
{
  "format_id": {"agent_url": "...", "id": "display_300x250"},
  "creative_manifest": { /* output from build_creative */ },
  "inputs": [{"name": "Desktop view"}, {"name": "Mobile view"}]
}

// Step 3: Sync (if preview looks good)
{
  "creative_manifests": [{ /* approved manifest */ }]
}
```

## Examples

### Example 1: Pure Generation

Generate a creative from scratch with just a message and brand context:

```json
{
  "message": "Create a 300x250 display banner for our winter sale. Use warm colors and emphasize the 50% discount",
  "target_format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "display_300x250"
  },
  "promoted_offerings": {
    "brand_manifest": {
      "url": "https://mybrand.com",
      "name": "My Brand",
      "colors": {
        "primary": "#FF5733",
        "secondary": "#C70039"
      }
    },
    "inline_offerings": [
      {
        "name": "Winter Sale Collection",
        "description": "50% off all winter items"
      }
    ]
  }
}
```

**Response**:
```json
{
  "creative_manifest": {
    "format_id": {
      "agent_url": "https://creative.adcontextprotocol.org",
      "id": "display_300x250"
    },
    "promoted_offering": "Winter Sale Collection",
    "assets": {
      "banner_image": {
        "asset_type": "image",
        "url": "https://cdn.creative-agent.com/generated/banner_12345.png",
        "width": 300,
        "height": 250
      },
      "clickthrough_url": {
        "asset_type": "url",
        "url": "https://mybrand.com/winter-sale"
      }
    }
  }
}
```

### Example 2: Format Transformation

Transform an existing 728x90 leaderboard to a 300x250 banner:

```json
{
  "message": "Adapt this leaderboard creative to a 300x250 banner format",
  "source_manifest": {
    "format_id": {
      "agent_url": "https://creative.adcontextprotocol.org",
      "id": "display_728x90"
    },
    "promoted_offering": "Spring Collection",
    "assets": {
      "banner_image": {
        "asset_type": "image",
        "url": "https://cdn.mybrand.com/leaderboard.png",
        "width": 728,
        "height": 90
      },
      "headline": {
        "asset_type": "text",
        "content": "Spring Sale - 30% Off Everything"
      },
      "clickthrough_url": {
        "asset_type": "url",
        "url": "https://mybrand.com/spring"
      }
    }
  },
  "target_format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "display_300x250"
  }
}
```

**Response**:
```json
{
  "creative_manifest": {
    "format_id": {
      "agent_url": "https://creative.adcontextprotocol.org",
      "id": "display_300x250"
    },
    "promoted_offering": "Spring Collection",
    "assets": {
      "banner_image": {
        "asset_type": "image",
        "url": "https://cdn.creative-agent.com/resized/banner_67890.png",
        "width": 300,
        "height": 250
      },
      "headline": {
        "asset_type": "text",
        "content": "Spring Sale - 30% Off"
      },
      "clickthrough_url": {
        "asset_type": "url",
        "url": "https://mybrand.com/spring"
      }
    }
  }
}
```

### Example 3: Transformation with Specific Instructions

Adapt a creative for mobile with specific design changes:

```json
{
  "message": "Make this mobile-friendly: increase text size, simplify the layout, and make the CTA button more prominent",
  "source_manifest": {
    "format_id": {
      "agent_url": "https://creative.adcontextprotocol.org",
      "id": "display_300x600"
    },
    "assets": {
      "background_image": {
        "asset_type": "image",
        "url": "https://cdn.mybrand.com/bg.jpg",
        "width": 300,
        "height": 600
      },
      "headline": {
        "asset_type": "text",
        "content": "Discover Our New Collection"
      },
      "body_text": {
        "asset_type": "text",
        "content": "Shop the latest styles with free shipping on orders over $50"
      },
      "cta_text": {
        "asset_type": "text",
        "content": "Shop Now"
      }
    }
  },
  "target_format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "display_mobile_320x50"
  }
}
```

**Response**:
```json
{
  "creative_manifest": {
    "format_id": {
      "agent_url": "https://creative.adcontextprotocol.org",
      "id": "display_mobile_320x50"
    },
    "assets": {
      "banner_image": {
        "asset_type": "image",
        "url": "https://cdn.creative-agent.com/mobile/banner_mobile_123.png",
        "width": 320,
        "height": 50
      },
      "headline": {
        "asset_type": "text",
        "content": "New Collection - Shop Now"
      },
      "clickthrough_url": {
        "asset_type": "url",
        "url": "https://mybrand.com/new"
      }
    }
  }
}
```
## Key Concepts

### Transformation Model

`build_creative` follows a **manifest-in, manifest-out** model:
- Input: Source creative manifest (can be minimal or complete)
- Process: Transform/generate based on `message` and `promoted_offerings`
- Output: Target creative manifest ready for preview or sync

### Pure Generation vs Transformation

- **Pure Generation**: Omit `source_manifest` or provide minimal version. The creative agent generates assets from scratch using `message` and `promoted_offerings`.
- **Transformation**: Provide complete `source_manifest`. The creative agent adapts existing assets to the target format, optionally following guidance in `message`.

### Integration with Other Tasks

1. **build_creative** → Generates manifest
2. **preview_creative** → Renders the manifest (see [preview_creative](./preview_creative.md))
3. **sync_creatives** → Traffics the finalized manifest

This separation allows you to:
- Build once, preview multiple times with different contexts
- Iterate on build without re-syncing
- Preview before committing to traffic