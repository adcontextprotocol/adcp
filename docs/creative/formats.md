---
title: Creative Formats
---

# Creative Formats

Creative formats define the structure, requirements, and delivery methods for advertising creatives. Each format specifies what assets are needed, their technical requirements, and how they should be assembled.

For an overview of how formats, manifests, and creative agents work together, see the [Creative Protocol Overview](./index.md).

## Creative Formats

Formats in AdCP are defined by publishers and creative agents. Each format specifies:
- Required and optional assets
- Technical requirements (dimensions, duration, file types)
- Asset roles and purposes
- Rendering instructions

Publishers provide format definitions through `list_creative_formats`. Formats can range from simple IAB standard sizes to complex multi-asset experiences:
- **Simple formats**: Standard banner sizes, basic video specs
- **Complex formats**: Rich media, multi-asset carousels, DOOH installations
- **Generative formats**: AI-powered creative generation
- **Third-party formats**: VAST, DAAST, HTML/JavaScript ad serving

See the [Creative Channel Guides](./channels/video.md) for format documentation across video, display, audio, DOOH, and carousels.

## Discovering Formats

Buyers discover available formats using the `list_creative_formats` task, which returns formats supported by a sales agent.

**Example discovery response:**

```json
{
  "formats": [
    {
      "format_id": {
        "agent_url": "https://youragent.com",
        "id": "homepage_takeover_2024"
      },
      "name": "Homepage Takeover",
      "type": "rich_media",
      "assets_required": [...]
    },
    {
      "format_id": {
        "agent_url": "https://youragent.com",
        "id": "display_300x250"
      },
      "name": "Medium Rectangle",
      "type": "display",
      "render_dimensions": {
        "width": 300,
        "height": 250,
        "responsive": {"width": false, "height": false},
        "unit": "px"
      },
      "assets_required": [...]
    }
  ]
}
```

## Format Authority

Each format includes an `agent_url` in its structured format_id, pointing to the authoritative source:

```json
{
  "format_id": {
    "agent_url": "https://youragent.com",
    "id": "video_30s_hosted"
  },
  "name": "30-Second Hosted Video"
}
```

The creative agent at that URL is the definitive source for:
- Complete format specifications
- Asset validation rules
- Preview generation
- Format documentation

Buyers use the agent_url from the format_id to query for full format details, validation, and preview capabilities.

## Format Visual Presentation

Formats include two optional fields for visual presentation in format browsing UIs:

### Preview Image
**Field**: `preview_image`
**Purpose**: Thumbnail/card image for format browsing
**Specifications**:
- **Dimensions**: 400×300px (4:3 aspect ratio)
- **Format**: PNG or JPG
- **Use case**: Quick visual identification in format lists/grids

### Example Showcase
**Field**: `example_url`
**Purpose**: Link to full interactive demo/showcase page
**Content**: Publisher-controlled page showing:
- Video walkthroughs of the format
- Interactive demos
- Multiple creative examples
- Technical specifications
- Best practices

**Why this approach?**
- Publishers control how to best showcase complex formats
- No schema limitations on presentation methods
- Handles video, interactive demos, DOOH installations, etc.
- Structured card (preview_image) + deep link (example_url) pattern

**Example**:
```json
{
  "format_id": "homepage_takeover_premium",
  "name": "Premium Homepage Takeover",
  "description": "Full-screen immersive experience with video, carousel, and companion units",
  "preview_image": "https://publisher.com/format-cards/homepage-takeover.png",
  "example_url": "https://publisher.com/formats/homepage-takeover-demo"
}
```

## Referencing Formats

**CRITICAL**: AdCP uses structured format ID objects everywhere to avoid parsing ambiguity and handle namespace collisions.

### Structured Format IDs (Required Everywhere)

**ALL format references** use structured format ID objects:

```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "display_300x250"
  }
}
```

**Why structured objects everywhere?**
- **No parsing needed**: Components are explicit
- **Unambiguous**: Clear separation of namespace and identifier
- **Handles collisions**: Same format ID from different agents are distinct
- **No exceptions**: Simpler mental model - one format_id pattern everywhere
- **Validation-friendly**: Easy to validate with JSON Schema
- **Extensible**: Can add version or other metadata later

### Where Structured Format IDs Are Used

**Requests:**
- `sync_creatives` - Uploading creative assets
- `build_creative` - Generating creatives via creative agents
- `preview_creative` - Preview generation
- `create_media_buy` - When specifying format requirements

**Responses:**
- `list_creatives` - Returning creative details
- `get_products` - Product format capabilities
- `list_creative_formats` - Format definitions
- Any response containing creative or format details

**Filter parameters:**
- `format_ids` (plural) in request filters - Array of structured format_id objects

### Validation Rules

**All AdCP agents MUST:**
1. ✅ Accept structured `format_id` objects in ALL contexts
2. ✅ Return structured `format_id` objects in ALL responses
3. ❌ Reject string format_ids with clear error messages
4. ❌ Never use string format_ids in any API contract

**Error handling for invalid format_id:**
```json
{
  "error": "invalid_format_id",
  "message": "format_id must be a structured object with 'agent_url' and 'id' fields",
  "received": "display_300x250",
  "required_structure": {
    "agent_url": "https://creative-agent-url.com",
    "id": "display_300x250"
  }
}
```

### Legacy Considerations

Some legacy systems may send string format_ids. Implementers have two options:

1. **Strict validation** (recommended): Reject strings immediately with clear error
2. **Auto-upgrade with deprecation**: Accept strings temporarily, log warnings, set removal timeline

If auto-upgrading, you MUST:
- Only accept strings for well-known formats you can map to agent URLs
- Fail loudly for unknown format strings
- Log deprecation warnings on every request
- Set and communicate a removal date (recommend 6 months maximum)

## Format Structure

Formats are JSON objects with the following key fields:

```json
{
  "format_id": "video_30s_hosted",
  "agent_url": "https://creative.adcontextprotocol.org",
  "name": "30-Second Hosted Video",
  "type": "video",
  "assets_required": [
    {
      "asset_id": "video_file",
      "asset_type": "video",
      "asset_role": "hero_video",
      "required": true,
      "requirements": {
        "duration": "30s",
        "format": ["MP4"],
        "resolution": ["1920x1080", "1280x720"]
      }
    }
  ]
}
```

**Key fields:**
- **format_id**: Unique identifier (may be namespaced with `domain:id`)
- **agent_url**: The creative agent authoritative for this format
- **type**: Category (video, display, audio, native, dooh, rich_media)
- **assets_required**: Array of asset specifications
- **asset_role**: Identifies asset purpose (hero_image, logo, cta_button, etc.)
- **render_dimensions**: Structured dimensions for visual formats (display, dooh, native) - see below

### Structured Rendering Dimensions

Visual formats (display, dooh, native) include structured `render_dimensions` for proper preview rendering and format filtering:

```json
{
  "format_id": "display_300x250",
  "type": "display",
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

**Dimension types:**

**Fixed dimensions** (standard display ads):
```json
{
  "width": 300,
  "height": 250,
  "responsive": {"width": false, "height": false},
  "unit": "px"
}
```

**Responsive width** (fluid banners):
```json
{
  "min_width": 300,
  "max_width": 970,
  "height": 250,
  "responsive": {"width": true, "height": false},
  "unit": "px"
}
```

**Aspect ratio constrained** (native formats):
```json
{
  "aspect_ratio": "16:9",
  "min_width": 300,
  "responsive": {"width": true, "height": true},
  "unit": "px"
}
```

**Physical dimensions** (DOOH):
```json
{
  "width": 48,
  "height": 14,
  "responsive": {"width": false, "height": false},
  "unit": "inches"
}
```

**Benefits of structured dimensions:**
- No string parsing required
- Schema-validated dimensions
- Supports responsive and fixed formats equally
- Enables proper preview rendering
- Allows dimension-based filtering
- Supports physical units for DOOH

## Format Categories

AdCP supports formats across multiple media types:

### Video Formats
- Standard video (15s, 30s, 60s)
- Vertical video for mobile/stories
- VAST/VPAID tags
- Interactive video

See [Video Channel Guide](./channels/video.md) for complete specifications.

### Display Formats
- Standard IAB sizes (300x250, 728x90, etc.)
- Responsive units
- Rich media and expandable
- HTML5 creative

See [Display Channel Guide](./channels/display.md) for complete specifications.

### Audio Formats
- Streaming audio (15s, 30s, 60s)
- Podcast insertion
- Companion banners
- VAST audio tags

See [Audio Channel Guide](./channels/audio.md) for complete specifications.

### DOOH Formats
- Digital billboards
- Transit displays
- Retail screens
- Venue-based impression tracking

See [DOOH Channel Guide](./channels/dooh.md) for complete specifications.

### Carousel/Multi-Asset Formats
- Product carousels (3-10 items)
- Story sequences
- Slideshow formats
- Frame-based structures

See [Carousel Channel Guide](./channels/carousels.md) for complete specifications.

## Multi-Asset & Frame-Based Formats

Some formats like carousels, slideshows, and stories use repeatable asset groups where each frame contains a collection of assets. See the [Carousel & Multi-Asset Formats guide](./channels/carousels.md) for complete documentation on frame-based format patterns.

## Related Documentation

- [Creative Protocol Overview](./index.md) - How formats, manifests, and agents work together
- [Creative Manifests](./creative-manifests.md) - Pairing assets with formats
- [Asset Types](./asset-types.md) - Understanding asset specifications
- [Channel Guides](./channels/video.md) - Detailed format documentation by media type
- [list_creative_formats Task](../media-buy/task-reference/list_creative_formats.md) - API reference for format discovery
