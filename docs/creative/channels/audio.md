---
title: Audio Ads
---

# Audio Ads

This guide covers how AdCP represents audio advertising formats for streaming audio, podcasts, and radio.

## Audio Format Characteristics

Audio formats include:
- **Hosted Audio** - Direct audio file URLs (MP3, M4A)
- **VAST Audio** - DAAST/VAST tags for programmatic audio
- **With Companion Banners** - Audio + synchronized display companion
- **Podcast Insertion** - Dynamic ad insertion (DAI) for podcasts

Audio ads are typically non-skippable and play during natural content breaks.

## Standard Audio Formats

### Streaming Audio (15s, 30s, 60s)

```json
{
  "format_id": "audio_30s",
  "type": "audio",
  "assets_required": [
    {
      "asset_id": "audio_file",
      "asset_type": "audio",
      "asset_role": "hero_audio",
      "required": true,
      "requirements": {
        "duration": "30s",
        "format": ["MP3", "M4A"],
        "bitrate_min": "128kbps",
        "max_file_size_mb": 5
      }
    }
  ]
}
```

### Audio with Companion Banner

```json
{
  "format_id": "audio_30s_companion",
  "type": "audio",
  "assets_required": [
    {
      "asset_id": "audio_file",
      "asset_type": "audio",
      "asset_role": "hero_audio",
      "required": true,
      "requirements": {
        "duration": "30s",
        "format": ["MP3", "M4A"],
        "bitrate_min": "128kbps"
      }
    },
    {
      "asset_id": "companion_banner",
      "asset_type": "image",
      "asset_role": "companion_banner",
      "required": false,
      "requirements": {
        "width": 640,
        "height": 640,
        "file_types": ["jpg", "png", "webp"],
        "notes": "Displays during audio playback on screen-enabled devices"
      }
    }
  ]
}
```

### Podcast Mid-Roll (60s)

```json
{
  "format_id": "podcast_midroll_60s",
  "type": "audio",
  "assets_required": [
    {
      "asset_id": "audio_file",
      "asset_type": "audio",
      "asset_role": "hero_audio",
      "required": true,
      "requirements": {
        "duration": "60s",
        "format": ["MP3", "M4A"],
        "bitrate_min": "128kbps",
        "max_file_size_mb": 10
      }
    }
  ]
}
```

### Dynamic Audio Creative (DAC)

Multi-segment audio assembled dynamically:

```json
{
  "format_id": "audio_dynamic_30s",
  "type": "audio",
  "assets_required": [
    {
      "asset_id": "intro_audio",
      "asset_type": "audio",
      "asset_role": "intro",
      "required": true,
      "requirements": {
        "duration": "5s",
        "format": ["MP3"]
      }
    },
    {
      "asset_id": "product_audio",
      "asset_type": "audio",
      "asset_role": "product_message",
      "required": true,
      "requirements": {
        "duration": "15s",
        "format": ["MP3"]
      }
    },
    {
      "asset_id": "cta_audio",
      "asset_type": "audio",
      "asset_role": "call_to_action",
      "required": true,
      "requirements": {
        "duration": "10s",
        "format": ["MP3"]
      }
    }
  ],
  "delivery": {
    "method": "server_side_stitching"
  }
}
```

## Creative Manifests

### Hosted Audio Manifest

```json
{
  "format_id": "audio_30s",
  "assets": {
    "audio_file": {
      "asset_type": "audio",
      "url": "https://cdn.brand.com/audio_spring_30s.mp3",
      "duration": 30,
      "format": "audio/mpeg"
    },
    "impression_tracker": {
      "asset_type": "url",
      "url_purpose": "impression_tracker",
      "url": "https://track.brand.com/imp?buy={MEDIA_BUY_ID}&station={APP_BUNDLE}&cb={CACHEBUSTER}"
    },
    "landing_url": {
      "asset_type": "url",
      "url_purpose": "clickthrough",
      "url": "https://brand.com/spring?campaign={MEDIA_BUY_ID}"
    }
  }
}
```

### VAST Audio Tag Manifest

```json
{
  "format_id": "audio_30s_vast",
  "assets": {
    "vast_url": {
      "asset_type": "url",
      "url_purpose": "vast_url",
      "url": "https://ad-server.brand.com/audio-vast?campaign={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    }
  }
}
```

### Audio with Companion Banner Manifest

```json
{
  "format_id": "audio_30s_companion",
  "assets": {
    "audio_file": {
      "asset_type": "audio",
      "url": "https://cdn.brand.com/audio_spring_30s.mp3",
      "duration": 30,
      "format": "audio/mpeg"
    },
    "companion_banner": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/companion_640x640.jpg",
      "width": 640,
      "height": 640
    },
    "landing_url": {
      "asset_type": "url",
      "url_purpose": "clickthrough",
      "url": "https://brand.com/spring-sale?source=audio&cb={CACHEBUSTER}"
    }
  }
}
```

## Audio-Specific Macros

In addition to [universal macros](../universal-macros.md), audio formats support:

### Content Context
- `{CONTENT_GENRE}` - podcast, music, news, talk
- `{CONTENT_RATING}` - Explicit, Clean
- `{SHOW_NAME}` - Podcast or show name
- `{EPISODE_ID}` - Episode identifier
- `{ARTIST_NAME}` - Currently playing artist (music platforms)
- `{TRACK_GENRE}` - Music genre of current track

### Platform Context
- `{APP_BUNDLE}` - Streaming app ID (Spotify, Apple Music, etc.)
- `{STATION_ID}` - Radio station ID
- `{LISTENING_MODE}` - Free tier, Premium, Trial
- `{DEVICE_TYPE}` - Mobile, Desktop, Smart Speaker, Auto

### Ad Insertion
- `{INSERTION_TYPE}` - preroll, midroll, postroll
- `{TIME_OF_DAY}` - morning, afternoon, evening, night
- `{DAY_PART}` - Commute, Workout, Work, Relaxation

## Platform-Specific Requirements

### Streaming Music (Spotify, Pandora, Apple Music)
- Free tier: Non-skippable audio between songs
- Typical durations: 15s or 30s
- Optional companion banner on screen-enabled devices

### Podcast Insertion
- **Baked-in**: Permanently encoded in episode
- **Dynamic insertion (SSAI)**: Personalized, with targeting and reporting

### Companion Banners
Appear alongside audio on screen-enabled devices:
- Mobile apps, desktop players, smart speakers with displays
- Common sizes: 640x640 (square), 320x50 (mobile banner)

## Common File Specifications

### Audio Files
- **Format**: MP3 or M4A
- **Bitrate**: Minimum 128kbps, recommended 192kbps
- **Sample Rate**: 44.1kHz or 48kHz
- **Channels**: Stereo or mono

### Durations
- **15s**: Quick message, high frequency
- **30s**: Standard, most common
- **60s**: Story-driven, common in podcasts

## Related Documentation

- [Universal Macros](../universal-macros.md) - Complete macro reference
- [Creative Manifests](../creative-manifests.md) - Manifest structure and validation
- [Asset Types](../asset-types.md) - Audio asset specifications
