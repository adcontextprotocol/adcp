---
title: Asset Types
---

# Asset Types

Creative formats in AdCP use standardized asset types with well-defined properties. This ensures consistency across formats and makes it easier for buyers to understand requirements.

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

HTML5 creative assets for rich media formats.

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
- `format`: HTML format type (html5, amphtml)
- `max_initial_load_kb`: Maximum initial load size
- `max_total_size_kb`: Maximum total size including all assets
- `allowed_features`: Allowed HTML5 features
- `restricted_features`: Features that must not be used

## Common Properties

All asset types share these common properties:

- `asset_type`: The type of asset (video, image, text, url, audio, html)
- `required`: Boolean indicating if the asset is mandatory

## Usage in Creative Formats

Creative formats specify their required assets using these standardized types:

```json
{
  "format_id": "video_15s_hosted",
  "assets": [
    {
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

## Frame-Based Formats

For formats with multiple frames (like carousels), assets are defined within a `frame_schema`:

```json
{
  "min_frames": 3,
  "max_frames": 10,
  "frame_schema": {
    "assets": [
      {
        "asset_type": "image",
        "required": true,
        "width": 600,
        "height": 600,
        "acceptable_formats": ["jpg", "png"]
      },
      {
        "asset_type": "text",
        "required": true,
        "text_type": "headline",
        "max_length": 50
      }
    ]
  },
  "global_assets": [
    {
      "asset_type": "image",
      "required": true,
      "width": 200,
      "height": 50,
      "acceptable_formats": ["png", "svg"],
      "notes": "Brand logo"
    }
  ]
}
```

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