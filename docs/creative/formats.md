---
title: Creative Formats
---

# Creative Formats

Creative formats define the structure, requirements, and delivery methods for advertising creatives. Each format specifies what assets are needed, their technical requirements, and how they should be assembled.

For an overview of how formats, manifests, and creative agents work together, see the [Creative Protocol Overview](./index.md).

## Standard vs Custom Formats

AdCP defines two categories of formats:

### Standard Formats
Pre-defined, industry-standard specifications that work consistently across publishers:
- **Simplified**: No platform-specific complexity
- **Portable**: One creative works everywhere
- **Validated**: Pre-tested specifications
- **Discoverable**: Available via `list_creative_formats`

See the [Creative Channel Guides](./channels/video.md) for format documentation across video, display, audio, DOOH, and carousels.

**For sales agents:** See [Implementing Standard Format Support](../media-buy/capability-discovery/implementing-standard-formats.md) for guidance on referencing the reference creative agent at `https://creative.adcontextprotocol.org`.

### Custom Formats
Publisher-specific formats for unique inventory:
- **Unique**: Truly differentiated experiences
- **Specialized**: Platform-specific capabilities
- **Extended**: Often based on standard formats
- **Documented**: Clear specifications required
- **Powered by Creative Agents**: Publishers provide creative agents that understand and support their custom formats

## Discovering Formats

Buyers discover available formats using the `list_creative_formats` task, which returns formats supported by a sales agent.

**Formats can come from two sources:**

1. **Directly from the sales agent** - Custom formats defined by the publisher
2. **Referenced creative agents** - The sales agent points to other creative agents (like the reference agent) for additional format support

**Example discovery response:**

```json
{
  "formats": [
    {
      "format_id": "homepage_takeover_2024",
      "agent_url": "https://youragent.com",
      "name": "Homepage Takeover",
      "type": "rich_media"
    }
  ],
  "creative_agents": [
    "https://creative.adcontextprotocol.org"
  ]
}
```

This tells buyers: "We support our custom homepage takeover format, PLUS all standard formats from the reference creative agent."

**For sales agents implementing format support:** See [Implementing Standard Format Support](../media-buy/capability-discovery/implementing-standard-formats.md).

## Format Authority

Each format includes an `agent_url` field pointing to its authoritative source:

```json
{
  "format_id": "video_30s_hosted",
  "agent_url": "https://creative.adcontextprotocol.org",
  "name": "Standard 30-Second Video"
}
```

The creative agent at that URL is the definitive source for:
- Complete format specifications
- Asset validation rules
- Preview generation
- Format documentation

Buyers query the agent_url for full format details, validation, and preview capabilities.

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
- [Implementing Standard Format Support](../media-buy/capability-discovery/implementing-standard-formats.md) - For sales agents
- [list_creative_formats Task](../media-buy/task-reference/list_creative_formats.md) - API reference for format discovery
