---
title: Creative Protocol
---

# Creative Protocol

This guide explains how creatives work in AdCP, from defining format requirements to assembling and delivering ads.

## The Four Key Concepts

### 1. **Assets**
The individual building blocks: images, videos, text, HTML, JavaScript, tracking URLs.

**Example**: A product image, a headline, a 30-second video file, a VAST tag.

### 2. **Formats**
Specifications that define what assets are required and how they should be assembled.

**Example**: "video_30s" format requires a 30-second MP4 video file with specific dimensions and codec.

### 3. **Manifests**
Packages that provide the actual assets to fulfill a format's requirements.

**Example**: A manifest for "video_30s" provides the URL to your actual 30-second video file, plus tracking pixels and landing page URL.

### 4. **Creative Agents**
Services that:
- Define and document formats (authoritative source)
- Explain how to render each format
- Validate manifests against format requirements
- Generate previews showing how creatives will look
- Optionally: build manifests from natural language briefs

## How They Fit Together

```
Format Definition (by Creative Agent)
  ↓
  "video_30s format requires:
   - One video file asset (MP4, 30s, 1920x1080)
   - One clickthrough URL"

Creative Manifest (by Buyer)
  ↓
  "Here's my actual video file:
   https://cdn.brand.com/spring_30s.mp4
   Landing page: https://brand.com/spring-sale"

Sales Agent (validates & delivers)
  ↓
  - Checks: Is this really 30 seconds? Is it MP4?
  - Adds: Impression tracking, click tracking
  - Delivers: Creative to ad server
```

## The Workflow

### 1. **Discovery** - "What formats do you support?"

Buyers call `list_creative_formats` on sales or creative agents to discover available formats with full specifications.

```json
{
  "format_id": "video_30s",
  "agent_url": "https://creative.example.com",
  "type": "video",
  "assets_required": [
    {
      "asset_id": "video_file",
      "asset_type": "video",
      "requirements": {
        "duration": "30s",
        "format": "MP4 H.264",
        "resolution": ["1920x1080", "1280x720"]
      }
    }
  ]
}
```

**Key Point**: The `agent_url` tells you where the authoritative documentation for this format lives - that creative agent defines how it works and how to render it.

### 2. **Assembly** - "Here are my assets"

Buyers create manifests providing assets that fulfill format requirements:

```json
{
  "format_id": "video_30s",
  "assets": {
    "video_file": {
      "asset_type": "video",
      "url": "https://cdn.brand.com/spring_30s.mp4",
      "duration": 30,
      "width": 1920,
      "height": 1080
    },
    "landing_url": {
      "asset_type": "url",
      "url_purpose": "clickthrough",
      "url": "https://brand.com/spring"
    }
  }
}
```

### 3. **Validation** - "Does this match the requirements?"

Creative agents validate manifests:
- Are all required assets provided?
- Do they meet technical specs (duration, dimensions, file size)?
- Are tracking macros formatted correctly?

### 4. **Delivery** - "Traffic this to the ad server"

Sales agents deliver validated creatives to their ad servers, translating AdCP universal concepts to platform-specific formats.

## Core Concepts

### Assets & Asset Types
Assets are the raw materials. Each has a type that determines its purpose:
- **image**: Static images (JPEG, PNG, WebP)
- **video**: Video files (MP4, WebM) or VAST tags
- **audio**: Audio files (MP3, M4A) or DAAST tags
- **text**: Headlines, descriptions, CTAs
- **html**: HTML5 creatives or third-party tags
- **javascript**: JavaScript tags
- **url**: Tracking pixels, clickthrough URLs, webhooks

See [Asset Types](asset-types.md) for detailed specifications.

### Formats & Format Authority
Each format has an authoritative source - the creative agent that defines it (indicated by `agent_url`). That agent:
- Hosts the definitive documentation
- Explains how to assemble assets
- Describes how the format renders
- Provides validation rules

**No special "standard" designation** - the reference creative agent's formats are just formats like any other. What matters is the `agent_url` pointing to the authority.

See the [Channel Guides](channels/video.md) for format examples and patterns across video, display, audio, DOOH, and carousels.

### Manifests
Manifests are JSON structures pairing asset IDs from the format with actual asset content:

```json
{
  "format_id": "product_carousel",
  "assets": {
    "product_0_image": { "asset_type": "image", "url": "..." },
    "product_0_title": { "asset_type": "text", "content": "..." },
    "product_1_image": { "asset_type": "image", "url": "..." },
    "logo": { "asset_type": "image", "url": "..." }
  }
}
```

For formats with repeatable asset groups (carousels, slideshows), use numbered sequences: `product_0_image`, `product_1_image`, `product_2_image`.

See [Creative Manifests](creative-manifests.md) for detailed documentation.

### Universal Macros
Macros are placeholders in tracking URLs that get replaced with actual values at impression time:

```
https://track.brand.com/imp?campaign={MEDIA_BUY_ID}&device={DEVICE_ID}&cb={CACHEBUSTER}
```

Becomes:
```
https://track.brand.com/imp?campaign=mb_spring_2025&device=ABC-123&cb=87654321
```

AdCP defines universal macros that work across all platforms - sales agents translate them to their ad server's syntax.

See [Universal Macros](universal-macros.md) for complete reference.

## Common Patterns

### Third-Party Tags
For third-party served ads, formats specify HTML or JavaScript asset requirements:

```json
{
  "format_id": "display_300x250_3p",
  "assets_required": [
    {
      "asset_id": "tag",
      "asset_type": "javascript",
      "requirements": {
        "width": 300,
        "height": 250,
        "max_file_size_kb": 200
      }
    }
  ]
}
```

### Repeatable Asset Groups
For carousels, slideshows, stories, playlists - anything with multiple repetitions of the same structure:

```json
{
  "asset_group_id": "product",
  "repeatable": true,
  "min_count": 3,
  "max_count": 10,
  "assets": [
    {"asset_id": "image", "asset_type": "image"},
    {"asset_id": "title", "asset_type": "text"},
    {"asset_id": "price", "asset_type": "text"}
  ]
}
```

Manifests provide: `product_0_image`, `product_0_title`, `product_0_price`, `product_1_image`, etc.

### DOOH & Proof-of-Play
Digital Out-of-Home formats include venue-specific macros and proof-of-play webhooks:

```json
{
  "proof_of_play": {
    "asset_type": "url",
    "url_purpose": "proof_of_play",
    "url": "https://track.com/pop?screen={SCREEN_ID}&ts={PLAY_TIMESTAMP}",
    "required_macros": ["SCREEN_ID", "PLAY_TIMESTAMP", "VENUE_LAT", "VENUE_LONG"]
  }
}
```

## Channel-Specific Information

For detailed information on specific ad formats and channels, see the [Creative Manifests](creative-manifests.md) documentation which covers:

- **Video Ads** - VAST, hosted video, CTV formats
- **Display Ads** - Banners, third-party tags, responsive formats
- **Audio Ads** - Streaming audio formats
- **DOOH** - Digital billboards, venue targeting, proof-of-play
- **Repeatable Asset Groups** - Carousels, slideshows, story formats

## Getting Started

1. **Discover formats**: Call `list_creative_formats` to see what's available
2. **Choose your channel guide**: Pick the guide that matches your campaign type
3. **Build your manifest**: Follow the format requirements
4. **Use universal macros**: Add tracking with standardized macros
5. **Preview**: Use `preview_creative` to see how it looks
6. **Submit**: Include manifests in your `create_media_buy` request

## Additional Resources

- [Creative Task Reference](task-reference/list_creative_formats.md) - API documentation for creative tasks
- [Generative Creative](generative-creative.md) - AI-powered creative generation guide
