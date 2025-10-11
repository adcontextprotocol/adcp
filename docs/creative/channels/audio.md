---
title: Audio Ads
---

# Audio Ads

This guide covers audio advertising formats for streaming audio, podcasts, and radio.

## Overview

Audio formats include:

1. **Hosted Audio** - Audio file URLs (MP3, M4A)
2. **VAST Audio** - VAST tags for audio ads
3. **With Companion Banners** - Audio + display companion

## Common Audio Formats

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
      "requirements": {
        "duration": "30s",
        "format": ["MP3", "M4A"]
      }
    },
    {
      "asset_id": "companion_banner",
      "asset_type": "image",
      "required": false,
      "requirements": {
        "width": 640,
        "height": 640,
        "file_types": ["jpg", "png"]
      }
    }
  ]
}
```

## Creating Audio Manifests

### Hosted Audio

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

### VAST Audio Tag

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

## Audio-Specific Macros

In addition to [universal macros](../universal-macros.md):

### Content Context
- `{CONTENT_GENRE}` - podcast, music, news, talk
- `{CONTENT_RATING}` - Explicit, Clean
- `{SHOW_NAME}` - Podcast or show name
- `{EPISODE_ID}` - Episode identifier

### Platform
- `{APP_BUNDLE}` - Streaming app ID (Spotify, Apple Music, etc.)
- `{STATION_ID}` - Radio station ID

## Best Practices

### File Encoding
- **Format**: MP3 or M4A
- **Bitrate**: Minimum 128kbps, recommended 192kbps
- **Sample Rate**: 44.1kHz or 48kHz
- **Channels**: Stereo or mono

### Duration
- **15s**: Quick message, high frequency
- **30s**: Standard, most common
- **60s**: Story-driven, brand building

### Audio Quality
- Normalize volume levels
- Clear, professional voiceover
- Background music should not overpower voice
- Test on various devices/headphones

### Companion Banners
- Use 640x640 or 300x250
- Static images work best
- Should reinforce audio message
- Include brand logo and CTA

## Related Documentation

- [Universal Macros](../universal-macros.md)
- [Creative Manifests](../creative-manifests.md)
- [Asset Types](../asset-types.md)
