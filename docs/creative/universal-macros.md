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
| `{TIMESTAMP}` | Unix timestamp in milliseconds | `1704067200000` |
| `{CLICK_URL}` | Publisher's click tracking URL | *(auto-inserted by sales agent)* |

### Privacy & Compliance Macros

**Critical for regulatory compliance** - Use these to respect user privacy choices in your creative logic.

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{GDPR}` | GDPR applicability flag | `1` (applies), `0` (doesn't apply) |
| `{GDPR_CONSENT}` | IAB TCF 2.0 consent string | `CPc7TgPPc7TgPAGABC...` |
| `{US_PRIVACY}` | US Privacy (CCPA) string | `1YNN` |
| `{GPP_STRING}` | Global Privacy Platform consent string | `DBABMA~1...` |
| `{LIMIT_AD_TRACKING}` | Limit Ad Tracking enabled | `1` (limited), `0` (allowed) |

**Example - Privacy-aware tracking**:
```javascript
// In creative logic
if (GDPR == 1 && GDPR_CONSENT == '') {
  // No consent - don't load tracking pixels
} else {
  // Load tracking
}
```

### Device & Environment Macros

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{DEVICE_TYPE}` | Device category | `mobile`, `tablet`, `desktop`, `ctv`, `dooh` |
| `{OS}` | Operating system | `iOS`, `Android`, `tvOS`, `Roku` |
| `{OS_VERSION}` | OS version | `17.2`, `14.0` |
| `{DEVICE_MAKE}` | Device manufacturer | `Apple`, `Samsung`, `Roku` |
| `{DEVICE_MODEL}` | Device model | `iPhone15,2`, `Roku Ultra` |
| `{USER_AGENT}` | Full user agent string | `Mozilla/5.0 ...` |
| `{APP_BUNDLE}` | App bundle ID (domain or numeric) | `com.publisher.app`, `123456789` |
| `{APP_NAME}` | Human-readable app name | `Publisher News App` |

### Geographic Macros

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{COUNTRY}` | ISO 3166-1 alpha-2 country code | `US`, `GB`, `CA`, `FR`, `JP`, `AU` |
| `{REGION}` | State/province/region code | `NY`, `CA` (US states), `ON` (Canada), `IDF` (France), `NSW` (Australia) |
| `{CITY}` | City name | `New York`, `London`, `Tokyo`, `Sydney` |
| `{ZIP}` | Postal code | `10001` (US), `SW1A 1AA` (UK), `75001` (France), `100-0001` (Japan) |
| `{DMA}` | [Nielsen DMA code](https://help.thetradedesk.com/s/article/Nielsen-DMA-Regions) (US TV markets) | `501` (New York), `803` (Los Angeles) |
| `{LAT}` | Latitude | `40.7128`, `51.5074`, `35.6762` |
| `{LONG}` | Longitude | `-74.0060`, `-0.1278`, `139.6503` |

### Identity Macros

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{DEVICE_ID}` | Mobile advertising ID (IDFA/AAID) | `ABC-123-DEF-456` |
| `{DEVICE_ID_TYPE}` | Type of device ID | `idfa`, `aaid` |

### Web Context Macros

For web-based inventory:

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{DOMAIN}` | Domain where ad is shown | `nytimes.com` |
| `{PAGE_URL}` | Full page URL (encoded) | `https%3A%2F%2F...` |
| `{REFERRER}` | HTTP referrer URL | `https://google.com` |
| `{KEYWORDS}` | Page keywords (comma-separated) | `business,finance,tech` |

### Placement & Position Macros

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{PLACEMENT_ID}` | Global Placement ID (IAB standard) | `12345678` |
| `{FOLD_POSITION}` | Position relative to fold (display) | `above_fold`, `below_fold` |
| `{AD_WIDTH}` | Ad slot width | `300`, `728` |
| `{AD_HEIGHT}` | Ad slot height | `250`, `90` |

### Video Content Macros

For video formats with content context:

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{VIDEO_ID}` | Content video identifier | `vid_12345` |
| `{VIDEO_TITLE}` | Content video title | `Breaking News Story` |
| `{VIDEO_DURATION}` | Content duration in seconds | `600` |
| `{VIDEO_CATEGORY}` | IAB content category | `IAB1` (Arts & Entertainment) |
| `{CONTENT_GENRE}` | Content genre | `news`, `sports`, `comedy` |
| `{CONTENT_RATING}` | Content rating | `G`, `PG`, `TV-14` |
| `{PLAYER_WIDTH}` | Video player width | `1920` |
| `{PLAYER_HEIGHT}` | Video player height | `1080` |

### Video Ad Pod Macros

For video ads in commercial breaks:

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{POD_POSITION}` | Position within ad break | `1`, `2`, `3` |
| `{POD_SIZE}` | Total ads in this break | `3` |
| `{AD_BREAK_ID}` | Unique ad break identifier | `break_mid_1` |

**Note**: Video formats also support all [IAB VAST 4.x macros](http://interactiveadvertisingbureau.github.io/vast/vast4macros/vast4-macros-latest.html) like `[CACHEBUSTING]`, `[TIMESTAMP]`, `[DOMAIN]`, `[IFA]`, etc. These work natively in VAST XML.

### AXE Integration

| Macro | Description | Example Value |
|-------|-------------|---------------|
| `{AXEM}` | AXE contextual metadata (encoded blob) | `eyJjb250ZXh0IjoiLi4uIn0=` |

> **Note**: Publisher-specific custom macros may be defined in individual creative format specifications as `extra supported macros`.

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

## Macro Availability by Inventory Type

Not all macros are available in all inventory types. Check format specifications to see which macros are supported.

| Macro Category | Display | Video | Audio | Native | CTV/OTT | DOOH | Mobile App | Mobile Web | Desktop Web |
|----------------|---------|-------|-------|--------|---------|------|------------|------------|-------------|
| **Common** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `{MEDIA_BUY_ID}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `{PACKAGE_ID}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `{CREATIVE_ID}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `{CACHEBUSTER}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Privacy** | | | | | | | | | |
| `{GDPR}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `{GDPR_CONSENT}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `{US_PRIVACY}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `{LIMIT_AD_TRACKING}` | ❌ | ✅* | ✅* | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| **Identity** | | | | | | | | | |
| `{DEVICE_ID}` | ❌ | ✅* | ✅* | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `{DEVICE_ID_TYPE}` | ❌ | ✅* | ✅* | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| **Geographic** | | | | | | | | | |
| `{COUNTRY}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `{REGION}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `{CITY}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `{ZIP}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `{DMA}` | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `{LAT}/{LONG}` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅† | ✅† | ❌ |
| **Device** | | | | | | | | | |
| `{DEVICE_TYPE}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `{OS}` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `{OS_VERSION}` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `{APP_BUNDLE}` | ❌ | ✅* | ✅* | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `{USER_AGENT}` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Web Context** | | | | | | | | | |
| `{DOMAIN}` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| `{PAGE_URL}` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| `{REFERRER}` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| `{KEYWORDS}` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Placement** | | | | | | | | | |
| `{PLACEMENT_ID}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `{FOLD_POSITION}` | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Video Content** | | | | | | | | | |
| `{VIDEO_ID}` | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `{VIDEO_CATEGORY}` | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `{CONTENT_GENRE}` | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Video Ad Pods** | | | | | | | | | |
| `{POD_POSITION}` | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `{POD_SIZE}` | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `{AD_BREAK_ID}` | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |

**Legend**:
- ✅ = Available
- ❌ = Not available
- ✅* = In-app only (not mobile web)
- ✅† = When location permission granted

**Important Notes**:
- Privacy macros (`{LIMIT_AD_TRACKING}`, `{DEVICE_ID}`) may return empty values based on user privacy settings
- Geographic macros accuracy varies by publisher's data capabilities
- `{PLACEMENT_ID}` refers to the IAB Global Placement ID standard

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
      "category": "identity",
      "description": "AdCP media buy identifier",
      "required": false,
      "privacy_sensitive": false,
      "example_value": "mb_spring_2025"
    },
    {
      "macro": "{DEVICE_ID}",
      "category": "identity",
      "description": "Mobile advertising ID (IDFA/AAID)",
      "required": false,
      "privacy_sensitive": true,
      "example_value": "ABC-123-DEF-456"
    },
    {
      "macro": "{GDPR}",
      "category": "privacy",
      "description": "GDPR applicability flag",
      "required": true,
      "privacy_sensitive": false,
      "example_value": "1"
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

**Critical**: Always respect user privacy choices in your creative logic.

#### GDPR Compliance (EU Traffic)

For campaigns serving in the EU:

```javascript
// Check consent before loading tracking
if (GDPR == 1) {
  if (GDPR_CONSENT && GDPR_CONSENT != '') {
    // User has consented - load tracking pixels
    loadTracking();
  } else {
    // No consent - skip tracking
    console.log('Tracking skipped - no GDPR consent');
  }
} else {
  // GDPR doesn't apply - load tracking
  loadTracking();
}
```

#### US Privacy / CCPA Compliance

For US traffic:

```javascript
// Check US Privacy string
if (US_PRIVACY == '1YYN') {
  // User has opted out - don't sell personal info
  skipPersonalizedTracking();
} else {
  // Load normal tracking
  loadTracking();
}
```

#### Device-Level Privacy

Respect Limit Ad Tracking settings:

```javascript
// Check if device ID is available
if (LIMIT_AD_TRACKING == 1 || DEVICE_ID == '' || DEVICE_ID == '00000000-0000-0000-0000-000000000000') {
  // User has limited tracking - use contextual attribution
  useContextualTracking();
} else {
  // Device ID available
  useDeviceTracking(DEVICE_ID);
}
```

#### Privacy Macro Behavior

**Empty Values**: Privacy-restricted macros return empty strings or zeros:
- `{DEVICE_ID}` → `""` or `00000000-0000-0000-0000-000000000000` when LAT enabled
- `{GDPR_CONSENT}` → `""` when no consent provided
- `{IP_ADDRESS}` → `""` or masked IP when privacy restricted

**Always test for empty values** before using privacy-sensitive macros.

### URL Encoding

No need to URL-encode macro placeholders. The ad server handles encoding of actual values automatically.

**Example**:
```
❌ WRONG: https://track.com/imp?device=%7BDEVICE_ID%7D
✅ CORRECT: https://track.com/imp?device={DEVICE_ID}
```

The ad server will URL-encode the actual value when replacing the macro.

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

- [Creative Formats](../media-buy/capability-discovery/creative-formats.md) - Supported format specifications
- [Creative Protocol](./index.md) - How creatives work in AdCP
- [sync_creatives](../media-buy/task-reference/sync_creatives.md) - Creative management API