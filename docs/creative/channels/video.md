---
title: Video Ads
---

# Video Ads

This guide covers video creative formats in AdCP, including hosted video files and VAST tags.

## Overview

Video formats fall into two main delivery methods:

1. **Hosted Video** - You provide video file URLs, publisher's ad server hosts/serves them
2. **VAST Tags** - You provide VAST XML, your ad server serves the video

## Common Video Format Patterns

### Hosted Video by Duration

Standard durations with technical requirements:

#### 15-Second Video
```json
{
  "format_id": "video_15s",
  "type": "video",
  "assets_required": [
    {
      "asset_id": "video_file",
      "asset_type": "video",
      "asset_role": "hero_video",
      "required": true,
      "requirements": {
        "duration": "15s",
        "format": "MP4 H.264",
        "resolution": ["1920x1080", "1280x720"],
        "max_file_size_mb": 30,
        "bitrate": "8-10 Mbps"
      }
    }
  ]
}
```

#### 30-Second Video
Same structure, `duration: "30s"`, `max_file_size_mb: 50`

#### 6-Second Bumper
Same structure, `duration: "6s"`, `max_file_size_mb`: 15

### VAST Tag Formats

For third-party served video:

```json
{
  "format_id": "video_30s_vast",
  "type": "video",
  "assets_required": [
    {
      "asset_id": "vast_tag",
      "asset_type": "url",
      "asset_role": "vast_url",
      "required": true,
      "requirements": {
        "vast_version": ["3.0", "4.0", "4.1", "4.2"],
        "duration": "30s"
      }
    }
  ]
}
```

### Vertical/Mobile Video

For mobile-optimized vertical video:

```json
{
  "format_id": "video_vertical_15s",
  "type": "video",
  "assets_required": [
    {
      "asset_id": "video_file",
      "asset_type": "video",
      "requirements": {
        "duration": "15s",
        "aspect_ratio": "9:16",
        "resolution": "1080x1920",
        "format": "MP4 H.264"
      }
    }
  ]
}
```

## Creating Video Manifests

### Hosted Video Manifest

```json
{
  "format_id": "video_30s",
  "assets": {
    "video_file": {
      "asset_type": "video",
      "url": "https://cdn.brand.com/spring_30s.mp4",
      "duration": 30,
      "width": 1920,
      "height": 1080,
      "format": "video/mp4"
    },
    "impression_tracker": {
      "asset_type": "url",
      "url_purpose": "impression_tracker",
      "url": "https://track.brand.com/imp?buy={MEDIA_BUY_ID}&cre={CREATIVE_ID}&cb={CACHEBUSTER}"
    },
    "landing_url": {
      "asset_type": "url",
      "url_purpose": "clickthrough",
      "url": "https://brand.com/spring-sale?campaign={MEDIA_BUY_ID}"
    }
  }
}
```

### VAST Tag Manifest

```json
{
  "format_id": "video_30s_vast",
  "assets": {
    "vast_tag": {
      "asset_type": "url",
      "url_purpose": "vast_url",
      "url": "https://ad-server.brand.com/vast?campaign={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    }
  }
}
```

### Inline VAST XML Manifest

```json
{
  "format_id": "video_30s_vast",
  "assets": {
    "vast_xml": {
      "asset_type": "vast_xml",
      "content": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<VAST version=\"4.2\">\n  <Ad>\n    <InLine>\n      <Impression><![CDATA[https://track.brand.com/imp?buy={MEDIA_BUY_ID}&cb=[CACHEBUSTING]]]></Impression>\n      <Creatives>\n        <Creative>\n          <Linear>\n            <Duration>00:00:30</Duration>\n            <MediaFiles>\n              <MediaFile delivery=\"progressive\" type=\"video/mp4\" width=\"1920\" height=\"1080\">\n                <![CDATA[https://cdn.brand.com/spring_30s.mp4]]>\n              </MediaFile>\n            </MediaFiles>\n            <VideoClicks>\n              <ClickThrough><![CDATA[https://brand.com/spring?campaign={MEDIA_BUY_ID}]]></ClickThrough>\n            </VideoClicks>\n          </Linear>\n        </Creative>\n      </Creatives>\n    </InLine>\n  </Ad>\n</VAST>"
    }
  }
}
```

## Video-Specific Macros

In addition to [universal macros](../universal-macros.md), video formats support:

### Video Content Context
- `{VIDEO_ID}` - Content video identifier
- `{VIDEO_TITLE}` - Content video title
- `{VIDEO_DURATION}` - Content duration in seconds
- `{VIDEO_CATEGORY}` - IAB content category
- `{CONTENT_GENRE}` - Content genre (news, sports, comedy)
- `{CONTENT_RATING}` - Content rating (G, PG, TV-14)
- `{PLAYER_WIDTH}` / `{PLAYER_HEIGHT}` - Video player dimensions

### Ad Pod Position
- `{POD_POSITION}` - Position within ad break (1, 2, 3)
- `{POD_SIZE}` - Total ads in this break
- `{AD_BREAK_ID}` - Unique ad break identifier

### VAST Macros
Video formats also support all [IAB VAST 4.x macros](http://interactiveadvertisingbureau.github.io/vast/vast4macros/vast4-macros-latest.html):
- `[CACHEBUSTING]` - Random number for cache prevention
- `[TIMESTAMP]` - Unix timestamp
- `[DOMAIN]` - Publisher domain
- `[IFA]` - Device advertising ID (IDFA/AAID)
- And many more

**Important**: Mix AdCP macros (`{CURLY_BRACES}`) and VAST macros (`[SQUARE_BRACKETS]`) - both work together:

```
https://track.brand.com/imp?
  buy={MEDIA_BUY_ID}&
  device=[IFA]&
  cb=[CACHEBUSTING]
```

## Video Ad Types

### Pre-Roll
Video ad that plays before content starts. Most common video format.

**Typical formats**: `video_15s`, `video_30s`, `video_6s`

### Mid-Roll
Video ad that plays during content breaks. Uses ad pod macros.

**Typical formats**: `video_15s`, `video_30s` with `{POD_POSITION}` macros

### Post-Roll
Video ad that plays after content ends. Less common but valuable for completion attribution.

**Typical formats**: `video_15s`, `video_30s`

### Out-Stream
Video ad that plays in feed/article content, not in a video player.

**Typical formats**: `video_vertical_15s`, custom out-stream formats

## CTV / OTT Considerations

Connected TV and Over-The-Top platforms have specific requirements:

### TV-Safe Areas
Ensure important content is within TV-safe zones (avoid edges that might be cut off)

### File Size
OTT platforms prefer smaller files:
- 15s: Max 20MB
- 30s: Max 35MB

### Aspect Ratios
Standard: 16:9 (1920x1080, 1280x720)

### Audio
Stereo audio required, normalized levels

### Companion Banners
Many CTV formats support optional companion banners shown alongside video

## Best Practices

### File Encoding
- **Container**: MP4
- **Video Codec**: H.264
- **Audio Codec**: AAC
- **Bitrate**: 8-10 Mbps for high quality, 4-6 Mbps for mobile
- **Frame Rate**: 23.976, 24, 25, 29.97, or 30 fps

### Multiple Resolutions
Provide both 1920x1080 and 1280x720 for broader compatibility

### VAST Best Practices
- Use VAST 4.2 when possible (latest spec)
- Include viewability tracking (`<Verification>`)
- Provide skip controls if format allows
- Test with major video players (JW Player, Video.js, etc.)

### Tracking
Always include:
- Impression trackers (fires on ad start)
- Quartile tracking (25%, 50%, 75% completion)
- Complete tracking (100% watched)
- Click tracking (user engagement)

### Landing Pages
Ensure landing pages work on the device type:
- CTV: QR codes or short URLs (no clickthrough)
- Mobile: Direct clickthrough to mobile-optimized pages
- Desktop: Standard landing pages

## Example: Complete Video Campaign

Format definition:
```json
{
  "format_id": "video_30s_ctv",
  "type": "video",
  "assets_required": [
    {
      "asset_id": "video_file",
      "asset_type": "video",
      "requirements": {
        "duration": "30s",
        "format": "MP4 H.264",
        "resolution": ["1920x1080"],
        "max_file_size_mb": 35
      }
    }
  ]
}
```

Manifest:
```json
{
  "format_id": "video_30s_ctv",
  "assets": {
    "video_file": {
      "asset_type": "video",
      "url": "https://cdn.brand.com/ctv_spring_30s.mp4",
      "duration": 30,
      "width": 1920,
      "height": 1080
    },
    "impression_tracker": {
      "asset_type": "url",
      "url_purpose": "impression_tracker",
      "url": "https://track.brand.com/imp?buy={MEDIA_BUY_ID}&pod={POD_POSITION}&cb={CACHEBUSTER}"
    },
    "quartile_tracker": {
      "asset_type": "url",
      "url_purpose": "quartile_tracker",
      "url": "https://track.brand.com/q?buy={MEDIA_BUY_ID}&pct={PERCENT}&cb={CACHEBUSTER}"
    },
    "complete_tracker": {
      "asset_type": "url",
      "url_purpose": "video_complete_tracker",
      "url": "https://track.brand.com/complete?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    }
  }
}
```

## Related Documentation

- [Universal Macros](../universal-macros.md) - Complete macro reference
- [Creative Manifests](../creative-manifests.md) - Manifest structure details
- [Asset Types](../asset-types.md) - Video asset specifications
