---
title: Universal Macros
---

# Universal Macros

Universal macros enable buyers to include dynamic tracking data in their creatives without needing to know each publisher's ad server implementation details. Macros are placeholders that get replaced with actual values at impression time.

## Overview

When you provide creative assets to AdCP, you can include universal macro placeholders in:
- Impression tracking URLs
- Click tracking URLs
- VAST tracking events
- Landing page URLs

**Example**:
```
https://track.brand.com/imp?
  campaign={MEDIA_BUY_ID}&
  creative={CREATIVE_ID}&
  device={DEVICE_ID}&
  cb={CACHEBUSTER}
```

At impression time, this becomes:
```
https://track.brand.com/imp?
  campaign=mb_spring_2025&
  creative=cr_video_30s&
  device=ABC-123-DEF&
  cb=87654321
```

## Available Macros by Format

Different creative formats support different macros. Use `list_creative_formats` to see which macros are available for each format.

### Common Macros (All Formats)

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{MEDIA_BUY_ID}` | Your AdCP media buy identifier | `mb_spring_2025` |
| `{PACKAGE_ID}` | Your AdCP package identifier | `pkg_ctv_prime` |
| `{CREATIVE_ID}` | Your AdCP creative identifier | `cr_video_30s` |
| `{CACHEBUSTER}` | Random number to prevent caching | `87654321` |
| `{CLICK_URL}` | Publisher's click tracking URL | *(auto-inserted by sales agent)* |

### Video Format Macros

In addition to common macros, video formats support:

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{DEVICE_ID}` | Mobile advertising ID (IDFA/AAID) | `ABC-123-DEF-456` |
| `{DEVICE_ID_TYPE}` | Type of device ID | `idfa`, `aaid` |
| `{DOMAIN}` | Domain where ad is shown | `nytimes.com` |
| `{VIDEO_ID}` | Content video identifier | `video_12345` |
| `{CONTENT_PLAYHEAD}` | Video content position | `00:05:23` |

**VAST Standard Macros**: Video formats also support all [IAB VAST 4.x macros](http://interactiveadvertisingbureau.github.io/vast/vast4macros/vast4-macros-latest.html) like `[CACHEBUSTING]`, `[TIMESTAMP]`, `[DOMAIN]`, `[IFA]`, etc. These work natively in VAST XML.

### Audio Format Macros

In addition to common macros, audio formats support:

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{DEVICE_ID}` | Mobile advertising ID | `ABC-123-DEF-456` |
| `{DOMAIN}` | Domain/app where ad is shown | `spotify.com` |
| `{STATION_ID}` | Radio station or podcast feed | `WXYZ-FM` |
| `{SHOW_NAME}` | Podcast or show name | `Tech News Daily` |

### Display/Native Format Macros

In addition to common macros, display/native formats support:

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{DEVICE_ID}` | Mobile advertising ID | `ABC-123-DEF-456` |
| `{DOMAIN}` | Site domain | `nytimes.com` |
| `{PAGE_URL}` | Full page URL (encoded) | `https%3A%2F%2F...` |

### Custom Macros

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{AXEM}` | AXE contextual metadata (weather, time, etc.) | `weather:sunny,time:morning` |
| `{CUSTOM:key}` | Custom field (by agreement with publisher) | *(varies)* |

## Usage Examples

### Video Creative with Tracking

```json
{
  "creative_id": "cr_video_30s",
  "format_id": "video_30s_vast",
  "assets": [
    {
      "asset_id": "vast_xml",
      "asset_type": "vast_xml",
      "content": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<VAST version=\"4.2\">\n  <Ad>\n    <InLine>\n      <Impression><![CDATA[https://track.brand.com/imp?buy={MEDIA_BUY_ID}&pkg={PACKAGE_ID}&cre={CREATIVE_ID}&device={DEVICE_ID}&domain={DOMAIN}&cb=[CACHEBUSTING]]]></Impression>\n      <Creatives>\n        <Creative>\n          <Linear>\n            <Duration>00:00:30</Duration>\n            <TrackingEvents>\n              <Tracking event=\"firstQuartile\"><![CDATA[https://track.brand.com/q1?buy={MEDIA_BUY_ID}&cb=[CACHEBUSTING]]]></Tracking>\n              <Tracking event=\"complete\"><![CDATA[https://track.brand.com/complete?buy={MEDIA_BUY_ID}&cb=[CACHEBUSTING]]]></Tracking>\n            </TrackingEvents>\n            <VideoClicks>\n              <ClickThrough><![CDATA[https://brand.com/spring?campaign={MEDIA_BUY_ID}]]></ClickThrough>\n            </VideoClicks>\n            <MediaFiles>\n              <MediaFile delivery=\"progressive\" type=\"video/mp4\" width=\"1920\" height=\"1080\">\n                <![CDATA[https://cdn.brand.com/videos/spring_30s.mp4]]>\n              </MediaFile>\n            </MediaFiles>\n          </Linear>\n        </Creative>\n      </Creatives>\n    </InLine>\n  </Ad>\n</VAST>"
    }
  ]
}
```

**Key Points**:
- Mix AdCP macros (`{MEDIA_BUY_ID}`) with VAST macros (`[CACHEBUSTING]`)
- AdCP macros use `{CURLY_BRACES}`
- VAST macros use `[SQUARE_BRACKETS]`
- Both work together seamlessly

### Display Creative with Tracking

```json
{
  "creative_id": "cr_banner_300x250",
  "format_id": "display_banner_300x250",
  "assets": [
    {
      "asset_id": "banner_image",
      "asset_type": "image",
      "url": "https://cdn.brand.com/banners/spring_300x250.jpg"
    },
    {
      "asset_id": "impression_pixel",
      "asset_type": "url",
      "url_type": "impression_tracker",
      "url": "https://track.brand.com/imp?buy={MEDIA_BUY_ID}&pkg={PACKAGE_ID}&cre={CREATIVE_ID}&device={DEVICE_ID}&domain={DOMAIN}&cb={CACHEBUSTER}"
    },
    {
      "asset_id": "landing_url",
      "asset_type": "url",
      "url_type": "clickthrough",
      "url": "https://brand.com/spring?campaign={MEDIA_BUY_ID}"
    }
  ]
}
```

### Audio Creative with Tracking

```json
{
  "creative_id": "cr_audio_30s",
  "format_id": "audio_streaming_30s",
  "assets": [
    {
      "asset_id": "audio_file",
      "asset_type": "audio",
      "url": "https://cdn.brand.com/audio/spring_30s.mp3"
    },
    {
      "asset_id": "impression_tracker",
      "asset_type": "url",
      "url_type": "impression_tracker",
      "url": "https://track.brand.com/imp?buy={MEDIA_BUY_ID}&pkg={PACKAGE_ID}&station={STATION_ID}&show={SHOW_NAME}&cb={CACHEBUSTER}"
    }
  ]
}
```

## How Macros Work

### 1. Discovery

Query `list_creative_formats` to see which macros each format supports:

```json
{
  "format_id": "video_30s_vast",
  "type": "video",
  "supported_macros": [
    {
      "macro": "{MEDIA_BUY_ID}",
      "description": "AdCP media buy identifier",
      "required": false
    },
    {
      "macro": "{DEVICE_ID}",
      "description": "Mobile advertising ID (IDFA/AAID)",
      "required": false
    },
    {
      "macro": "{CACHEBUSTER}",
      "description": "Random cache busting number",
      "required": true
    }
  ],
  "vast_macros_supported": true
}
```

### 2. Include Macros in Creatives

Add macro placeholders in your tracking URLs using `{MACRO_NAME}` syntax:

```
https://track.brand.com/imp?campaign={MEDIA_BUY_ID}&device={DEVICE_ID}
```

### 3. Sales Agent Processing

When you create a media buy via `create_media_buy`, the sales agent:

1. **Replaces AdCP ID macros** with your actual IDs:
   - `{MEDIA_BUY_ID}` → `mb_spring_2025`
   - `{PACKAGE_ID}` → `pkg_ctv_prime`
   - `{CREATIVE_ID}` → `cr_video_30s`

2. **Translates platform macros** to their ad server's syntax:
   - `{CACHEBUSTER}` → `%%CACHEBUSTER%%` (GAM) or `{{timestamp}}` (Kevel)
   - `{DEVICE_ID}` → `%%ADVERTISING_IDENTIFIER_PLAIN%%` (GAM)
   - `{DOMAIN}` → `%%SITE%%` (GAM)

3. **Inserts click trackers** automatically into clickable elements

4. **Leaves VAST macros unchanged** (for video formats)

### 4. Impression Time

The publisher's ad server replaces remaining macros with actual values:

```
https://track.brand.com/imp?
  campaign=mb_spring_2025&
  device=ABC-123-DEF-456&
  cb=87654321
```

## Reconciliation

### Mapping Between Systems

Sales agents provide mapping between AdCP IDs and ad server IDs in the `create_media_buy` response:

```json
{
  "media_buy_id": "mb_spring_2025",
  "status": "active",
  "ad_server_mapping": {
    "order_id": "1234567",
    "packages": [
      {
        "package_id": "pkg_ctv_prime",
        "line_item_id": "8901234",
        "creatives": [
          {
            "creative_id": "cr_video_30s",
            "ad_server_creative_id": "5678901"
          }
        ]
      }
    ]
  }
}
```

### Using IDs for Reconciliation

Your tracking URLs automatically contain both your AdCP IDs and the publisher's ad server IDs, enabling automatic reconciliation:

**Your tracking system** sees:
- `campaign=mb_spring_2025` (your ID)
- 100,000 impressions

**Publisher's reporting** shows:
- Order 1234567
- 98,500 impressions

**Match them**: Use the mapping to correlate `mb_spring_2025` ↔ `1234567`

## Best Practices

### Use Macros Consistently

Include the same core set of macros across all your creatives:
```
?buy={MEDIA_BUY_ID}&pkg={PACKAGE_ID}&cre={CREATIVE_ID}&cb={CACHEBUSTER}
```

This makes your tracking data consistent and easier to analyze.

### Check Format Support

Always query `list_creative_formats` to see which macros are available. Not all formats support all macros.

### Combine VAST and AdCP Macros

For video, use both systems together:
- **VAST macros** `[CACHEBUSTING]`, `[TIMESTAMP]` - for standard video tracking
- **AdCP macros** `{MEDIA_BUY_ID}`, `{DEVICE_ID}` - for your campaign tracking

### Privacy Compliance

Device ID macros (`{DEVICE_ID}`) respect user privacy settings:
- Only populated when user has consented
- May be empty or masked based on privacy laws (GDPR, CCPA)
- Use `{DEVICE_LAT}` to check if user has limited ad tracking

### URL Encoding

No need to URL-encode macro placeholders. The ad server handles encoding of actual values automatically.

## Implementation Notes for Sales Agents

*This section is for AdCP implementers, not buyers.*

### Macro Translation Approach

Sales agents must translate universal macros to their ad server's native syntax. The recommended approach:

**Option 1: Hard-Code During Trafficking (MVP)**
- When creating ad server creatives, replace AdCP ID macros with actual values
- Translate platform macros to ad server syntax
- Creates one creative per line item but is simple and reliable

**Option 2: Dynamic Wrapper (Future)**
- Intercept ad calls and inject values dynamically
- More complex but avoids creative duplication

### Translation Examples

**Google Ad Manager**:
```javascript
{
  '{CACHEBUSTER}': '%%CACHEBUSTER%%',
  '{DEVICE_ID}': '%%ADVERTISING_IDENTIFIER_PLAIN%%',
  '{DEVICE_ID_TYPE}': '%%ADVERTISING_IDENTIFIER_TYPE%%',
  '{DOMAIN}': '%%SITE%%',
  '{VIDEO_ID}': '%%VIDEO_ID%%'
}
```

**Kevel**:
```javascript
{
  '{CACHEBUSTER}': '{{timestamp}}',
  '{DEVICE_ID}': '{{device.ifa}}',
  '{DEVICE_ID_TYPE}': '{{device.ifaType}}',
  '{DOMAIN}': '{{request.domain}}'
}
```

**Xandr Monetize**:
```javascript
{
  '{CACHEBUSTER}': '${CACHEBUSTER}',
  '{DEVICE_ID}': '${DEVICE_APPLE_IDA}',  // or ${DEVICE_AAID}
  '{DOMAIN}': '${DOMAIN}'
}
```

### Click Tracker Insertion

Sales agents must automatically insert click tracking macros into clickable elements:

**Original creative**:
```html
<a href="https://brand.com/product">Click here</a>
```

**After insertion (GAM)**:
```html
<a href="%%CLICK_URL_UNESC%%https://brand.com/product">Click here</a>
```

### Mapping Storage

Store the mapping between AdCP IDs and ad server IDs for reconciliation:

```javascript
{
  media_buy_id: "mb_spring_2025",
  ad_server_order_id: "1234567",
  packages: [
    {
      package_id: "pkg_ctv_prime",
      ad_server_line_item_id: "8901234"
    }
  ]
}
```

Return this in `create_media_buy` responses and make it queryable for reconciliation.

## Related Documentation

- [Creative Formats](../capability-discovery/creative-formats.md) - Supported format specifications
- [Creative Lifecycle](./index.md) - End-to-end creative workflow
- [sync_creatives](../task-reference/sync_creatives.md) - Creative management API