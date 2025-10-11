---
title: Display Ads
---

# Display Ads

This guide covers display advertising formats, from simple image banners to third-party HTML/JavaScript tags.

## Overview

Display formats include:

1. **Hosted Images** - Static images (JPG, PNG, WebP, GIF)
2. **HTML5** - Interactive HTML creatives with assets
3. **Third-Party Tags** - HTML or JavaScript tags served by your ad server

## Common Display Sizes

### Standard IAB Sizes

#### Medium Rectangle (300x250)
Most common display format, works well on desktop and mobile.

```json
{
  "format_id": "display_300x250",
  "type": "display",
  "dimensions": "300x250",
  "assets_required": [
    {
      "asset_id": "banner_image",
      "asset_type": "image",
      "asset_role": "hero_image",
      "required": true,
      "requirements": {
        "width": 300,
        "height": 250,
        "file_types": ["jpg", "png", "webp", "gif"],
        "max_file_size_kb": 200
      }
    }
  ]
}
```

#### Leaderboard (728x90)
Top-of-page banner, desktop-focused.

#### Wide Skyscraper (160x600)
Vertical sidebar format.

#### Billboard (970x250)
Premium large format.

### Mobile Sizes

#### Mobile Banner (320x50)
Standard mobile web banner.

#### Mobile Interstitial (320x480)
Full-screen mobile format.

## Hosted Image Formats

### Simple Image Banner

Format definition:
```json
{
  "format_id": "display_728x90",
  "type": "display",
  "dimensions": "728x90",
  "assets_required": [
    {
      "asset_id": "banner_image",
      "asset_type": "image",
      "requirements": {
        "width": 728,
        "height": 90,
        "file_types": ["jpg", "png", "webp"],
        "max_file_size_kb": 150
      }
    }
  ]
}
```

Manifest:
```json
{
  "format_id": "display_728x90",
  "assets": {
    "banner_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/leaderboard.jpg",
      "width": 728,
      "height": 90
    },
    "landing_url": {
      "asset_type": "url",
      "url_purpose": "clickthrough",
      "url": "https://brand.com/spring?campaign={MEDIA_BUY_ID}"
    },
    "impression_tracker": {
      "asset_type": "url",
      "url_purpose": "impression_tracker",
      "url": "https://track.brand.com/imp?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    }
  }
}
```

### Animated GIF

Same structure, use `.gif` file with animation:

```json
{
  "banner_image": {
    "asset_type": "image",
    "url": "https://cdn.brand.com/animated_300x250.gif",
    "width": 300,
    "height": 250,
    "animated": true,
    "animation_duration_ms": 15000
  }
}
```

**Best practice**: Keep animations under 15 seconds, loop no more than 3 times.

## Third-Party Tags

For ads served by your own ad server (DCO, DMP, etc.).

### JavaScript Tag Format

Format definition:
```json
{
  "format_id": "display_300x250_3p",
  "type": "display",
  "dimensions": "300x250",
  "assets_required": [
    {
      "asset_id": "tag",
      "asset_type": "javascript",
      "asset_role": "third_party_tag",
      "required": true,
      "requirements": {
        "width": 300,
        "height": 250,
        "max_file_size_kb": 200,
        "https_required": true
      }
    }
  ]
}
```

Manifest:
```json
{
  "format_id": "display_300x250_3p",
  "assets": {
    "tag": {
      "asset_type": "javascript",
      "content": "<script src=\"https://ad-server.brand.com/serve?campaign={MEDIA_BUY_ID}&size=300x250&cb={CACHEBUSTER}\"></script>"
    }
  }
}
```

### HTML Tag Format

Format definition uses `asset_type: "html"`:

```json
{
  "asset_id": "tag",
  "asset_type": "html",
  "requirements": {
    "width": 728,
    "height": 90,
    "max_file_size_kb": 200
  }
}
```

Manifest:
```json
{
  "tag": {
    "asset_type": "html",
    "content": "<iframe src=\"https://ad-server.brand.com/render?campaign={MEDIA_BUY_ID}&size=728x90&cb={CACHEBUSTER}\" width=\"728\" height=\"90\" frameborder=\"0\" scrolling=\"no\"></iframe>"
  }
}
```

## HTML5 Creative Formats

Interactive creatives with multiple assets.

### Multi-Asset Banner

Format definition:
```json
{
  "format_id": "display_300x250_html5",
  "type": "display",
  "dimensions": "300x250",
  "assets_required": [
    {
      "asset_id": "background_image",
      "asset_type": "image",
      "requirements": {"width": 300, "height": 250}
    },
    {
      "asset_id": "logo",
      "asset_type": "image",
      "requirements": {"width": 100, "height": 50}
    },
    {
      "asset_id": "headline",
      "asset_type": "text",
      "requirements": {"max_length": 25}
    },
    {
      "asset_id": "cta_text",
      "asset_type": "text",
      "requirements": {"max_length": 15}
    }
  ]
}
```

Manifest:
```json
{
  "format_id": "display_300x250_html5",
  "assets": {
    "background_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/bg.jpg"
    },
    "logo": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/logo.png"
    },
    "headline": {
      "asset_type": "text",
      "content": "Spring Sale - 50% Off"
    },
    "cta_text": {
      "asset_type": "text",
      "content": "Shop Now"
    },
    "landing_url": {
      "asset_type": "url",
      "url_purpose": "clickthrough",
      "url": "https://brand.com/spring"
    }
  }
}
```

The publisher's ad server assembles these into an HTML5 creative.

## Display-Specific Macros

In addition to [universal macros](../universal-macros.md), display formats commonly use:

### Placement
- `{PLACEMENT_ID}` - IAB Global Placement ID
- `{FOLD_POSITION}` - above_fold, below_fold
- `{AD_WIDTH}` / `{AD_HEIGHT}` - Ad slot dimensions

### Web Context
- `{DOMAIN}` - Publisher domain (e.g., "nytimes.com")
- `{PAGE_URL}` - Full page URL (encoded)
- `{REFERRER}` - HTTP referrer
- `{KEYWORDS}` - Page keywords (comma-separated)

### Device
- `{DEVICE_TYPE}` - mobile, tablet, desktop
- `{OS}` - iOS, Android, Windows, macOS
- `{USER_AGENT}` - Full user agent string

## Responsive Display Formats

Formats that adapt to different screen sizes.

### Flexible Banner

Format definition:
```json
{
  "format_id": "display_responsive",
  "type": "display",
  "responsive": true,
  "supported_sizes": ["300x250", "728x90", "320x50"],
  "assets_required": [
    {
      "asset_id": "background_image",
      "asset_type": "image",
      "requirements": {
        "min_width": 728,
        "min_height": 250,
        "responsive": true
      }
    },
    {
      "asset_id": "logo",
      "asset_type": "image"
    },
    {
      "asset_id": "headline",
      "asset_type": "text"
    }
  ]
}
```

The publisher's ad server renders at the appropriate size based on placement.

## Rich Media & Expandable Formats

### Expandable Banner

Starts collapsed, expands on user interaction.

Format definition:
```json
{
  "format_id": "display_970x250_expandable",
  "type": "display",
  "expandable": true,
  "collapsed_size": "970x250",
  "expanded_size": "970x600",
  "assets_required": [
    {
      "asset_id": "collapsed_creative",
      "asset_type": "html",
      "requirements": {
        "width": 970,
        "height": 250,
        "max_file_size_kb": 200
      }
    },
    {
      "asset_id": "expanded_creative",
      "asset_type": "html",
      "requirements": {
        "width": 970,
        "height": 600,
        "max_file_size_kb": 500
      }
    }
  ]
}
```

## Native Display Formats

Content-integrated display ads (covered more in detail in native ads guide).

### Responsive Native

Format definition:
```json
{
  "format_id": "native_responsive",
  "type": "display",
  "native": true,
  "assets_required": [
    {
      "asset_id": "primary_image",
      "asset_type": "image",
      "requirements": {
        "min_width": 600,
        "min_height": 600,
        "aspect_ratio": "1:1"
      }
    },
    {
      "asset_id": "headline",
      "asset_type": "text",
      "requirements": {"max_length": 80}
    },
    {
      "asset_id": "body",
      "asset_type": "text",
      "requirements": {"max_length": 200}
    },
    {
      "asset_id": "sponsor_name",
      "asset_type": "text",
      "requirements": {"max_length": 25}
    }
  ]
}
```

## Best Practices

### File Sizes
- **Images**: Max 200KB for banners, 150KB for mobile
- **Animated GIFs**: Max 500KB
- **HTML5**: Max 200KB initial load, 2.2MB total
- **Third-party tags**: Should load asynchronously

### Image Formats
- **JPEG**: Photos, gradients (lossy compression)
- **PNG**: Graphics with transparency, sharp edges
- **WebP**: Modern format, better compression (when supported)
- **GIF**: Simple animations only

### Animation Guidelines
- Maximum 15 seconds duration
- Maximum 3 loops
- End on clear call-to-action frame
- No strobing/flashing effects

### Third-Party Tag Requirements
- Must use HTTPS
- Must be SSL-compliant
- No auto-expansion (user-initiated only)
- No auto-play audio
- Respect user privacy settings

### Click Tracking
Publishers automatically wrap landing URLs with click trackers - no need to manually add `{CLICK_URL}` macro.

### Viewability
Most publishers measure viewability using MRC standards (50% visible for 1 second). Optimize creatives for above-the-fold placement.

## Example: Complete Display Campaign

Format definition:
```json
{
  "format_id": "display_300x250_standard",
  "type": "display",
  "dimensions": "300x250",
  "assets_required": [
    {
      "asset_id": "banner_image",
      "asset_type": "image",
      "requirements": {
        "width": 300,
        "height": 250,
        "max_file_size_kb": 150
      }
    }
  ]
}
```

Manifest:
```json
{
  "format_id": "display_300x250_standard",
  "assets": {
    "banner_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/spring_300x250.jpg",
      "width": 300,
      "height": 250
    },
    "landing_url": {
      "asset_type": "url",
      "url_purpose": "clickthrough",
      "url": "https://brand.com/spring?utm_campaign={MEDIA_BUY_ID}&utm_source={DOMAIN}&utm_medium=display"
    },
    "impression_tracker": {
      "asset_type": "url",
      "url_purpose": "impression_tracker",
      "url": "https://track.brand.com/imp?buy={MEDIA_BUY_ID}&pkg={PACKAGE_ID}&domain={DOMAIN}&placement={PLACEMENT_ID}&fold={FOLD_POSITION}&cb={CACHEBUSTER}"
    },
    "viewability_tracker": {
      "asset_type": "url",
      "url_purpose": "viewability_tracker",
      "url": "https://track.brand.com/view?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    }
  }
}
```

## Related Documentation

- [Universal Macros](../universal-macros.md) - Complete macro reference
- [Creative Manifests](../creative-manifests.md) - Manifest structure details
- [Asset Types](../asset-types.md) - Image and HTML asset specifications
