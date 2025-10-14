---
title: Video Ads
---

# Video Ads

This guide covers how AdCP represents video advertising formats for online video, CTV, and streaming platforms.

## Video Format Characteristics

Video formats include:
- **Hosted Video** - Direct video file URLs served by publisher ad servers
- **VAST Tags** - Third-party ad server URLs returning VAST/VPAID XML
- **Inline VAST XML** - Complete VAST XML provided in creative manifest
- **Multiple Resolutions** - Same creative in different encoding profiles

Video ads play before (pre-roll), during (mid-roll), or after (post-roll) video content, or in-feed as out-stream video.

## Standard Video Formats

### Horizontal Video by Duration

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
        "format": ["MP4"],
        "codec": "H.264",
        "resolution": ["1920x1080", "1280x720"],
        "max_file_size_mb": 30,
        "bitrate_min": "4Mbps",
        "bitrate_max": "10Mbps",
        "audio_codec": "AAC"
      }
    }
  ]
}
```

#### 30-Second Video
```json
{
  "format_id": "video_30s",
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
        "codec": "H.264",
        "resolution": ["1920x1080", "1280x720"],
        "max_file_size_mb": 50,
        "bitrate_min": "4Mbps",
        "bitrate_max": "10Mbps",
        "audio_codec": "AAC"
      }
    }
  ]
}
```

#### 6-Second Bumper
```json
{
  "format_id": "video_6s",
  "type": "video",
  "assets_required": [
    {
      "asset_id": "video_file",
      "asset_type": "video",
      "asset_role": "hero_video",
      "required": true,
      "requirements": {
        "duration": "6s",
        "format": ["MP4"],
        "codec": "H.264",
        "resolution": ["1920x1080", "1280x720"],
        "max_file_size_mb": 15,
        "bitrate_min": "4Mbps",
        "bitrate_max": "10Mbps"
      }
    }
  ]
}
```

### Vertical/Mobile Video

```json
{
  "format_id": "video_vertical_15s",
  "type": "video",
  "assets_required": [
    {
      "asset_id": "video_file",
      "asset_type": "video",
      "asset_role": "hero_video",
      "required": true,
      "requirements": {
        "duration": "15s",
        "aspect_ratio": "9:16",
        "resolution": "1080x1920",
        "format": ["MP4"],
        "codec": "H.264",
        "max_file_size_mb": 30
      }
    }
  ]
}
```

### CTV/OTT Video

```json
{
  "format_id": "video_30s_ctv",
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
        "codec": "H.264",
        "resolution": "1920x1080",
        "max_file_size_mb": 35,
        "bitrate_min": "4Mbps",
        "bitrate_max": "8Mbps",
        "audio_codec": "AAC",
        "audio_channels": "stereo"
      }
    }
  ]
}
```

### VAST Tag Formats

For third-party ad servers:

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

### VPAID Interactive Video

```json
{
  "format_id": "video_30s_vpaid",
  "type": "video",
  "assets_required": [
    {
      "asset_id": "vpaid_tag",
      "asset_type": "url",
      "asset_role": "vpaid_url",
      "required": true,
      "requirements": {
        "vpaid_version": ["2.0"],
        "duration": "30s",
        "api_framework": "VPAID"
      }
    }
  ]
}
```

## Creative Manifests

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
      "format": "video/mp4",
      "codec": "H.264",
      "bitrate_kbps": 8000
    },
    "impression_tracker": {
      "asset_type": "url",
      "url_purpose": "impression_tracker",
      "url": "https://track.brand.com/imp?buy={MEDIA_BUY_ID}&video={VIDEO_ID}&cb={CACHEBUSTER}"
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

### Multi-Resolution Manifest

```json
{
  "format_id": "video_30s",
  "assets": {
    "video_1080p": {
      "asset_type": "video",
      "url": "https://cdn.brand.com/spring_30s_1080p.mp4",
      "duration": 30,
      "width": 1920,
      "height": 1080,
      "bitrate_kbps": 8000
    },
    "video_720p": {
      "asset_type": "video",
      "url": "https://cdn.brand.com/spring_30s_720p.mp4",
      "duration": 30,
      "width": 1280,
      "height": 720,
      "bitrate_kbps": 5000
    },
    "video_480p": {
      "asset_type": "video",
      "url": "https://cdn.brand.com/spring_30s_480p.mp4",
      "duration": 30,
      "width": 854,
      "height": 480,
      "bitrate_kbps": 2500
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
- `{CONTENT_RATING}` - Content rating (G, PG, TV-14, etc.)
- `{PLAYER_WIDTH}` / `{PLAYER_HEIGHT}` - Video player dimensions in pixels

### Ad Pod Position
- `{POD_POSITION}` - Position within ad break (1, 2, 3, etc.)
- `{POD_SIZE}` - Total ads in this break
- `{AD_BREAK_ID}` - Unique ad break identifier

### Playback Context
- `{PLAYBACK_METHOD}` - auto-play-sound-on, auto-play-sound-off, click-to-play
- `{PLAYER_SIZE}` - small, medium, large, fullscreen
- `{VIDEO_PLACEMENT}` - in-stream, in-banner, in-article, in-feed, interstitial

### VAST Macros

AdCP macros (`{CURLY_BRACES}`) work alongside [IAB VAST 4.x macros](http://interactiveadvertisingbureau.github.io/vast/vast4macros/vast4-macros-latest.html) (`[SQUARE_BRACKETS]`):

- `[CACHEBUSTING]` - Random number for cache prevention
- `[TIMESTAMP]` - Unix timestamp
- `[DOMAIN]` - Publisher domain
- `[IFA]` - Device advertising ID (IDFA/AAID)
- `[REGULATIONS]` - Privacy regulation signals (GDPR, CCPA)
- `[DEVICEUA]` - Device user agent string

**Example mixing both macro formats:**
```
https://track.brand.com/imp?
  buy={MEDIA_BUY_ID}&
  video={VIDEO_ID}&
  device=[IFA]&
  domain=[DOMAIN]&
  cb=[CACHEBUSTING]
```

## Video Tracking Assets

### Standard Tracking Events

```json
{
  "format_id": "video_30s",
  "assets": {
    "video_file": {
      "asset_type": "video",
      "url": "https://cdn.brand.com/video_30s.mp4"
    },
    "impression_tracker": {
      "asset_type": "url",
      "url_purpose": "impression_tracker",
      "url": "https://track.brand.com/imp?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    },
    "start_tracker": {
      "asset_type": "url",
      "url_purpose": "video_start",
      "url": "https://track.brand.com/start?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    },
    "quartile_25_tracker": {
      "asset_type": "url",
      "url_purpose": "video_25percent",
      "url": "https://track.brand.com/q25?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    },
    "quartile_50_tracker": {
      "asset_type": "url",
      "url_purpose": "video_50percent",
      "url": "https://track.brand.com/q50?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    },
    "quartile_75_tracker": {
      "asset_type": "url",
      "url_purpose": "video_75percent",
      "url": "https://track.brand.com/q75?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    },
    "complete_tracker": {
      "asset_type": "url",
      "url_purpose": "video_complete",
      "url": "https://track.brand.com/complete?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    },
    "click_tracker": {
      "asset_type": "url",
      "url_purpose": "click_tracker",
      "url": "https://track.brand.com/click?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    }
  }
}
```

### Interactive Tracking Events

For formats supporting user interaction:

```json
{
  "pause_tracker": {
    "asset_type": "url",
    "url_purpose": "video_pause",
    "url": "https://track.brand.com/pause?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
  },
  "resume_tracker": {
    "asset_type": "url",
    "url_purpose": "video_resume",
    "url": "https://track.brand.com/resume?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
  },
  "skip_tracker": {
    "asset_type": "url",
    "url_purpose": "video_skip",
    "url": "https://track.brand.com/skip?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
  },
  "mute_tracker": {
    "asset_type": "url",
    "url_purpose": "video_mute",
    "url": "https://track.brand.com/mute?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
  },
  "unmute_tracker": {
    "asset_type": "url",
    "url_purpose": "video_unmute",
    "url": "https://track.brand.com/unmute?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
  }
}
```

## Common Aspect Ratios

- **16:9** (1920x1080, 1280x720) - Standard horizontal video
- **9:16** (1080x1920) - Vertical mobile video
- **4:3** (640x480) - Legacy format, rare
- **1:1** (1080x1080) - Square social video

## Video Placement Types

### Pre-Roll
Video ad plays before content starts. Most common placement.

**Common durations:** 6s, 15s, 30s

### Mid-Roll
Video ad plays during content breaks. Uses ad pod macros for position tracking.

**Common durations:** 15s, 30s

### Post-Roll
Video ad plays after content ends.

**Common durations:** 15s, 30s

### Out-Stream
Video ad plays in-feed or in-article, not in a video player.

**Common formats:** Vertical mobile video, in-feed video

## VAST/VPAID Integration

### VAST Versions

AdCP supports all VAST versions:
- **VAST 2.0** - Legacy support
- **VAST 3.0** - Adds verification and error handling
- **VAST 4.0** - Improved tracking, viewability
- **VAST 4.1** - Enhanced ad pod support
- **VAST 4.2** - Latest specification (recommended)

### VPAID Support

VPAID (Video Player Ad-Serving Interface Definition) enables interactive video ads:

```json
{
  "format_id": "video_30s_vpaid",
  "assets_required": [
    {
      "asset_id": "vpaid_tag",
      "asset_type": "url",
      "asset_role": "vpaid_url",
      "requirements": {
        "vpaid_version": ["2.0"],
        "api_framework": "VPAID"
      }
    }
  ]
}
```

## File Specifications

### Video Codecs
- **H.264** - Most widely supported
- **H.265/HEVC** - Better compression, limited support
- **VP8/VP9** - Open codec, growing support

### Audio Codecs
- **AAC** - Recommended for MP4
- **MP3** - Legacy support
- **Opus** - High quality, growing support

### Container Formats
- **MP4** - Industry standard
- **WebM** - Open format
- **MOV** - Apple format, transcoded by publishers

### Bitrate Ranges
- **High Quality (1080p):** 8-10 Mbps
- **Standard Quality (720p):** 4-6 Mbps
- **Mobile Optimized (480p):** 2-3 Mbps
- **CTV/OTT:** 4-8 Mbps (file size limits apply)

### Frame Rates
- 23.976 fps, 24 fps, 25 fps, 29.97 fps, 30 fps, 60 fps

### Common Resolutions

**16:9 Landscape:**
- 1920x1080 (1080p Full HD)
- 1280x720 (720p HD)
- 854x480 (480p SD)

**9:16 Portrait:**
- 1080x1920 (Mobile vertical)

**1:1 Square:**
- 1080x1080 (Social video)

## Related Documentation

- [Universal Macros](../universal-macros.md) - Complete macro reference including video macros
- [Creative Manifests](../creative-manifests.md) - Manifest structure and asset specifications
- [Asset Types](../asset-types.md) - Video asset type definitions
