---
title: Asset Types
---

# Asset Types

Creative formats in AdCP use standardized asset types with well-defined properties. This ensures consistency across formats and makes it easier for buyers to understand requirements.

## Important: Payload vs Requirements

**This document describes format requirements** (constraints and specifications defined in format specs).

For **payload schemas** (the structure of actual asset data you send in creative manifests), see:
- [Asset Type Registry](https://adcontextprotocol.org/schemas/v1/creative/asset-types/index.json) - Links to all payload schemas
- Core Asset Schemas at `/schemas/v1/core/assets/` - Individual asset payload definitions

**Key distinction**:
- **Format requirements** (this doc): `max_file_size_mb`, `required: true/false`, `acceptable_formats`, duration constraints
- **Payload schemas** (schemas): `url`, `width`, `height`, `content`, `duration_ms`, `format`

Asset requirements belong in the format specification's `requirements` field. Asset payloads use the core schemas.

## Asset Type Schema

The official JSON schema for asset types is available at:
- **Production**: https://adcontextprotocol.org/schemas/asset-types-v1.json
- **GitHub**: https://github.com/adcontextprotocol/adcp/blob/main/static/schemas/asset-types-v1.json

## Core Asset Types

### Video Asset

Video assets represent video files with specific technical requirements.

```json
{
  "asset_type": "video",
  "required": true,
  "duration_seconds": 15,
  "acceptable_formats": ["mp4"],
  "acceptable_codecs": ["h264"],
  "acceptable_resolutions": ["1920x1080", "1280x720"],
  "aspect_ratio": "16:9",
  "max_file_size_mb": 30,
  "min_bitrate_mbps": 8,
  "max_bitrate_mbps": 10
}
```

**Properties:**
- `duration_seconds`: Expected video duration
- `min_duration_seconds` / `max_duration_seconds`: Duration range (if flexible)
- `acceptable_formats`: Container formats (mp4, webm, mov)
- `acceptable_codecs`: Video codecs (h264, h265, vp8, vp9, av1)
- `acceptable_resolutions`: List of width x height strings
- `aspect_ratio`: Required aspect ratio (16:9, 9:16, 1:1, etc.)
- `max_file_size_mb`: Maximum file size in megabytes
- `min_bitrate_mbps` / `max_bitrate_mbps`: Bitrate range in Mbps
- `features`: Additional requirements (e.g., ["non-skippable", "sound on"])

### Image Asset

Static image assets for banners, logos, and visual content.

```json
{
  "asset_type": "image",
  "required": true,
  "width": 300,
  "height": 250,
  "acceptable_formats": ["jpg", "png", "gif"],
  "max_file_size_kb": 200,
  "animation_allowed": true
}
```

**Properties:**
- `width` / `height`: Dimensions in pixels
- `min_width` / `min_height`: Minimum dimensions (px; typically used by responsive/sizeless formats)
- `acceptable_formats`: Image formats (jpg, png, gif, webp, svg)
- `max_file_size_kb`: Maximum file size in kilobytes
- `transparency`: Whether transparency is required/supported
- `animation_allowed`: Whether animated GIFs are accepted
- `notes`: Additional requirements (e.g., "Must be free of text")

### Text Asset

Text content for headlines, descriptions, CTAs, etc.

```json
{
  "asset_type": "text",
  "required": true,
  "text_type": "headline",
  "max_length": 90,
  "min_length": 10
}
```

**Properties:**
- `text_type`: Specific type (title, headline, description, body, cta, advertiser_name, disclaimer)
- `max_length`: Maximum character count
- `min_length`: Minimum character count
- `default`: Default value if not provided
- `allowed_characters`: Regex pattern for validation
- `format`: Expected format (plain, currency, percentage)

### URL Asset

Links for clickthroughs, tracking, and landing pages.

```json
{
  "asset_type": "url",
  "required": true,
  "url_type": "clickthrough",
  "must_be_https": true,
  "tracking_macros_supported": true
}
```

**Properties:**
- `url_type`: Purpose (clickthrough, impression_tracker, video_tracker, landing_page)
- `must_be_https`: Whether HTTPS is required
- `allowed_domains`: List of allowed domains (if restricted)
- `tracking_macros_supported`: Whether URL macros are supported

### Audio Asset

Audio files for audio ads and podcasts.

```json
{
  "asset_type": "audio",
  "required": true,
  "duration_seconds": 30,
  "acceptable_formats": ["mp3", "m4a"],
  "min_bitrate_kbps": 128,
  "max_file_size_mb": 5
}
```

**Properties:**
- `duration_seconds`: Expected duration
- `acceptable_formats`: Audio formats (mp3, m4a, aac, ogg)
- `min_bitrate_kbps`: Minimum bitrate in kilobits per second
- `max_file_size_mb`: Maximum file size in megabytes
- `stereo_required`: Whether stereo audio is required

### HTML Asset

HTML5 creative assets for rich media formats and third-party display tags.

```json
{
  "asset_type": "html",
  "required": true,
  "format": "html5",
  "max_initial_load_kb": 200,
  "max_total_size_kb": 500,
  "restricted_features": ["document.write", "eval"]
}
```

**Properties:**
- `content`: Inline HTML content
- `url`: URL to externally hosted HTML file (alternative to inline content)
- `format`: HTML format type (html5, amphtml)
- `max_initial_load_kb`: Maximum initial load size
- `max_total_size_kb`: Maximum total size including all assets
- `allowed_features`: Allowed HTML5 features
- `restricted_features`: Features that must not be used

### VAST Asset

VAST (Video Ad Serving Template) tags for third-party video ad serving.

```json
{
  "asset_type": "vast",
  "required": true,
  "url": "https://vast.example.com/video/123",
  "vast_version": "4.1",
  "vpaid_enabled": false
}
```

**Properties:**
- `url`: URL endpoint that returns VAST XML
- `content`: Inline VAST XML content (alternative to URL)
- `vast_version`: VAST specification version (2.0, 3.0, 4.0, 4.1, 4.2)
- `vpaid_enabled`: Whether VPAID (Video Player-Ad Interface Definition) is supported
- `max_wrapper_depth`: Maximum allowed wrapper/redirect depth
- `duration_ms`: Expected video duration in milliseconds (if known)
- `tracking_events`: Array of supported tracking events

**Use Cases:**
- Third-party video ad servers
- Programmatic video buying
- Video ad networks
- VPAID interactive video ads

### DAAST Asset

DAAST (Digital Audio Ad Serving Template) tags for third-party audio ad serving.

```json
{
  "asset_type": "daast",
  "required": true,
  "url": "https://daast.example.com/audio/456",
  "daast_version": "1.0"
}
```

**Properties:**
- `url`: URL endpoint that returns DAAST XML
- `content`: Inline DAAST XML content (alternative to URL)
- `daast_version`: DAAST specification version (1.0, 1.1)
- `duration_ms`: Expected audio duration in milliseconds (if known)
- `tracking_events`: Array of supported tracking events
- `companion_ads`: Whether companion display ads are included

**Use Cases:**
- Third-party audio ad servers
- Podcast advertising networks
- Streaming audio platforms
- Radio-style digital audio ads

## Common Properties

All asset types share these common properties:

- `asset_id`: Unique identifier for this asset within the format (e.g., "hero_image", "video_file", "headline")
- `asset_type`: The type of asset (image, video, audio, text, html, css, javascript, vast, daast, url, promoted_offerings)
- `asset_role`: Semantic purpose of the asset (e.g., "hero_video", "logo", "cta_button")
- `required`: Boolean indicating if the asset is mandatory

### Asset ID vs Asset Role

**`asset_id`**: A unique identifier for this asset within the format specification. Used as the key when constructing manifests.

**`asset_role`**: Describes the semantic purpose or function of the asset in the creative. Helps buyers, AI systems, and publishers understand what the asset is for.

**Example**:
```json
{
  "asset_id": "main_video",
  "asset_type": "video",
  "asset_role": "hero_video",
  "required": true
}
```

In this example:
- `asset_id` = "main_video" (the unique identifier for manifests)
- `asset_role` = "hero_video" (indicates this is the primary video content)

**Common asset roles**:
- `hero_image` / `hero_video` - Primary visual content
- `logo` - Brand logo
- `headline` - Main headline text
- `description` - Body copy or description text
- `cta_button` - Call-to-action button
- `background_image` - Background visual
- `thumbnail` - Preview image
- `companion_banner` - Secondary display ad

Asset roles enable AI systems to generate appropriate content and help publishers understand how to render each asset in the creative.

### Asset ID Usage

The `asset_id` field is crucial for orchestrators and creative management systems. It provides a stable identifier for mapping uploaded assets to their correct positions in the creative format.

#### Example: Uploading Assets

When submitting creative assets, the orchestrator uses `asset_id` to map files:

```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "foundational_immersive_canvas"
  },
  "assets": {
    "hero_image": "https://cdn.example.com/campaign123/hero.jpg",
    "brand_logo": "https://cdn.example.com/brand/logo.png",
    "headline": "Discover Our New Collection",
    "description": "Experience premium quality with our latest products",
    "video_content": "https://cdn.example.com/campaign123/video.mp4"
  }
}
```

The keys in the assets object correspond to the `asset_id` values defined in the format.

## Usage in Creative Formats

Creative formats specify their required assets using these standardized types:

```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "video_15s_hosted"
  },
  "assets": [
    {
      "asset_id": "video_file",
      "asset_type": "video",
      "required": true,
      "duration_seconds": 15,
      "acceptable_formats": ["mp4"],
      "acceptable_codecs": ["h264"],
      "acceptable_resolutions": ["1920x1080", "1280x720"],
      "max_file_size_mb": 30
    }
  ]
}
```

## Repeatable Asset Groups

For formats with asset sequences (like carousels, slideshows, stories), see the [Carousel & Multi-Asset Formats guide](./channels/carousels.md) for complete documentation on repeatable asset group patterns.

## Validation

Implementations should validate assets against these schemas to ensure compatibility. The JSON schema can be used for automated validation:

```javascript
// Example validation (pseudocode)
const assetSchema = await fetch('https://adcontextprotocol.org/schemas/asset-types-v1.json');
const validator = new JsonSchemaValidator(assetSchema);

const videoAsset = {
  asset_type: "video",
  required: true,
  duration_seconds: 15,
  // ... other properties
};

const isValid = validator.validate(videoAsset, 'video');
```

## Best Practices

1. **Be Specific**: Use exact values rather than ranges when possible
2. **Include All Constraints**: Document all technical requirements upfront
3. **Use Standard Units**: 
   - File sizes: MB for video/audio, KB for images
   - Bitrates: Mbps for video, Kbps for audio
   - Durations: seconds
   - Dimensions: pixels
4. **Provide Reasonable Limits**: Balance quality with file size constraints
5. **Document Edge Cases**: Use the `notes` field for special requirements