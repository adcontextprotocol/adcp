---
title: DOOH (Digital Out-of-Home)
---

# DOOH - Digital Out-of-Home

This guide covers Digital Out-of-Home advertising formats for digital billboards, transit screens, and venue displays.

## Overview

DOOH formats are unique because:
- Ads display on physical screens in public spaces
- Venue context matters (airport, mall, highway, etc.)
- Proof-of-play verification confirms actual display
- No click tracking (but QR codes work)

## Common DOOH Formats

### Digital Billboard

```json
{
  "format_id": "dooh_billboard_1920x1080",
  "type": "dooh",
  "assets_required": [
    {
      "asset_id": "billboard_image",
      "asset_type": "image",
      "asset_role": "hero_image",
      "requirements": {
        "width": 1920,
        "height": 1080,
        "file_types": ["jpg", "png"],
        "max_file_size_kb": 500,
        "text_readable_distance": "50 feet minimum"
      }
    }
  ]
}
```

### Transit Screen

```json
{
  "format_id": "dooh_transit_1080x1920",
  "type": "dooh",
  "assets_required": [
    {
      "asset_id": "screen_image",
      "asset_type": "image",
      "requirements": {
        "width": 1080,
        "height": 1920,
        "aspect_ratio": "9:16"
      }
    }
  ]
}
```

## Proof-of-Play

DOOH formats include webhooks that fire when the creative actually displays on screen:

```json
{
  "format_id": "dooh_billboard_1920x1080",
  "assets_required": [
    {
      "asset_id": "billboard_image",
      "asset_type": "image",
      "requirements": {"width": 1920, "height": 1080}
    },
    {
      "asset_id": "proof_of_play",
      "asset_type": "url",
      "url_purpose": "proof_of_play",
      "required": true,
      "requirements": {
        "required_macros": ["SCREEN_ID", "PLAY_TIMESTAMP", "VENUE_LAT", "VENUE_LONG"]
      }
    }
  ]
}
```

## Creating DOOH Manifests

### Static Billboard

```json
{
  "format_id": "dooh_billboard_1920x1080",
  "assets": {
    "billboard_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/dooh_billboard.jpg",
      "width": 1920,
      "height": 1080
    },
    "proof_of_play": {
      "asset_type": "url",
      "url_purpose": "proof_of_play",
      "url": "https://track.brand.com/pop?buy={MEDIA_BUY_ID}&screen={SCREEN_ID}&venue={VENUE_TYPE}&ts={PLAY_TIMESTAMP}&lat={VENUE_LAT}&long={VENUE_LONG}"
    }
  }
}
```

### Video Billboard

```json
{
  "format_id": "dooh_video_15s",
  "assets": {
    "video_file": {
      "asset_type": "video",
      "url": "https://cdn.brand.com/dooh_15s.mp4",
      "duration": 15,
      "width": 1920,
      "height": 1080,
      "audio": false
    },
    "proof_of_play": {
      "asset_type": "url",
      "url_purpose": "proof_of_play",
      "url": "https://track.brand.com/pop?buy={MEDIA_BUY_ID}&screen={SCREEN_ID}&ts={PLAY_TIMESTAMP}"
    }
  }
}
```

## DOOH-Specific Macros

In addition to [universal macros](../universal-macros.md):

### Venue Information
- `{SCREEN_ID}` - Unique screen identifier
- `{VENUE_TYPE}` - airport, mall, transit, highway, retail
- `{VENUE_NAME}` - Specific venue name
- `{VENUE_LAT}` / `{VENUE_LONG}` - GPS coordinates

### Play Information
- `{PLAY_TIMESTAMP}` - When creative displayed (Unix timestamp)
- `{DWELL_TIME}` - Average dwell time at this location (seconds)
- `{LOOP_LENGTH}` - Total ad rotation duration (seconds)

Example proof-of-play URL with all macros:
```
https://track.brand.com/pop?
  buy={MEDIA_BUY_ID}&
  screen={SCREEN_ID}&
  venue={VENUE_TYPE}&
  venue_name={VENUE_NAME}&
  ts={PLAY_TIMESTAMP}&
  lat={VENUE_LAT}&
  long={VENUE_LONG}&
  dwell={DWELL_TIME}
```

## DOOH Best Practices

### Design for Distance
- **Large text**: Minimum 200px height for readability
- **High contrast**: Works in varying light conditions
- **Simple message**: 6-8 words maximum
- **Bold graphics**: Details get lost at distance

### No Audio
Most DOOH screens have no audio. Video should work with sound off.

### File Sizes
- **Static images**: Max 1MB (fast loading for rotation)
- **Video**: Max 50MB for 15s

### Aspect Ratios
Common DOOH aspect ratios:
- **16:9** (1920x1080) - Landscape billboards
- **9:16** (1080x1920) - Portrait transit/retail
- **1:1** (1080x1080) - Square formats

### Brightness & Contrast
- Design for outdoor viewing (high brightness)
- Test in various lighting conditions
- Avoid subtle gradients or low-contrast elements

### QR Codes
Since click-through isn't possible, use QR codes:
- Large enough to scan from distance (at least 200x200px)
- High contrast (black on white)
- Test scanning from various angles/distances
- Link to mobile-optimized landing pages

### Loop Duration
Most DOOH screens rotate ads:
- Typical loop: 15-30 seconds per ad
- Static: 8-15 seconds display time
- Video: Full duration played

### Venue Targeting
Use venue macros to understand performance:
- Track which venue types perform best
- Adjust messaging by venue (airport vs. mall)
- Optimize based on dwell time

## Proof-of-Play Verification

Unlike digital ads where impression tracking is probabilistic, DOOH proof-of-play is deterministic:

**What it confirms:**
- Creative actually displayed on screen
- Exact timestamp of display
- Specific screen location
- Venue context

**What to track:**
```json
{
  "media_buy_id": "mb_dooh_q1",
  "screen_id": "LAX_T1_GATE24",
  "venue_type": "airport",
  "venue_lat": "33.9416",
  "venue_long": "-118.4085",
  "play_timestamp": "1704067200",
  "dwell_time_seconds": "45"
}
```

## Example: Complete DOOH Campaign

Format definition:
```json
{
  "format_id": "dooh_billboard_highway",
  "type": "dooh",
  "venue_types": ["highway"],
  "assets_required": [
    {
      "asset_id": "billboard_image",
      "asset_type": "image",
      "requirements": {
        "width": 1920,
        "height": 1080,
        "text_size_min": "200px",
        "qr_code_size_min": "200x200"
      }
    },
    {
      "asset_id": "proof_of_play",
      "asset_type": "url",
      "url_purpose": "proof_of_play",
      "required": true
    }
  ]
}
```

Manifest:
```json
{
  "format_id": "dooh_billboard_highway",
  "assets": {
    "billboard_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/highway_billboard.jpg",
      "width": 1920,
      "height": 1080
    },
    "proof_of_play": {
      "asset_type": "url",
      "url_purpose": "proof_of_play",
      "url": "https://track.brand.com/pop?buy={MEDIA_BUY_ID}&screen={SCREEN_ID}&venue={VENUE_TYPE}&name={VENUE_NAME}&ts={PLAY_TIMESTAMP}&lat={VENUE_LAT}&long={VENUE_LONG}&dwell={DWELL_TIME}"
    }
  }
}
```

## Related Documentation

- [Universal Macros](../universal-macros.md) - Complete macro reference including DOOH macros
- [Creative Manifests](../creative-manifests.md) - Proof-of-play webhook details
- [Asset Types](../asset-types.md) - URL asset specifications
