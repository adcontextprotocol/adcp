---
title: Creative Manifests
sidebar_position: 4
---

# Creative Manifests

Creative manifests are structured specifications that define all the assets and metadata needed to render a creative in a specific format. They pair the requirements defined by [Creative Formats](./formats.md) with actual asset content.

For an overview of how formats, manifests, and creative agents work together, see the [Creative Protocol Overview](./index.md).


## Manifest Structure

### Basic Structure

```typescript
{
  format_id: {                 // Format this manifest is for
    agent_url: string;         // Creative agent URL
    id: string;                // Format identifier
  };
  promoted_offering?: string;  // Product being advertised (maps to create_media_buy)
  assets: {
    [asset_role: string]: {    // Keyed by asset role from format spec
      asset_type: string;      // Type: image, video, audio, vast_tag, text, url, html, javascript, webhook

      // Type-specific fields - see asset type schemas for details
      // Image: url, width, height, format, file_size, alt
      // Video: url, width, height, duration_seconds, format, codec, bitrate_mbps, file_size
      // Audio: url, duration_seconds, format, codec, bitrate_kbps, sample_rate_hz, channels
      // VAST: content, vast_version, vpaid_enabled, duration_seconds
      // Text: content, length, format (plain/html/markdown)
      // URL: url, purpose (clickthrough/tracking/etc)
      // HTML: content or url, width, height, file_size (for client-side tags)
      // JavaScript: content or url, inline (for client-side tags)
      // Webhook: url, method, timeout_ms, response_type, security, supported_macros (server-side)
    }
  };
}
```

### Asset Roles

Asset roles identify the purpose of each asset and map directly to format requirements:

**Common Asset Roles**:
- `hero_image`: Primary visual asset
- `logo`: Brand logo
- `headline`: Main headline text
- `description`: Body copy
- `cta_text`: Call-to-action button text
- `video_file`: Video content
- `vast_tag`: VAST XML for video delivery
- `dynamic_endpoint`: URL for real-time creative generation

Asset roles are defined by the format specification and vary by format type.

## Types of Creative Manifests

Creative manifests can be static, dynamic, or hybrid - reflecting the three creative agent modalities above.

### Static Manifests

Static manifests contain all assets ready for immediate rendering. These are produced by creative agents in **Static Asset Delivery** or **Prompt to Static Rendering** modes.

```json
{
  "format_id": "native_responsive",
  "assets": {
    "hero_image": {
      "asset_type": "image",
      "url": "https://cdn.example.com/hero.jpg",
      "width": 1200,
      "height": 627,
      "format": "jpg",
      "alt": "Product image"
    },
    "logo": {
      "asset_type": "image",
      "url": "https://cdn.example.com/logo.png",
      "width": 100,
      "height": 100,
      "format": "png"
    },
    "headline": {
      "asset_type": "text",
      "content": "Premium Quality You Can Trust"
    },
    "description": {
      "asset_type": "text",
      "content": "Discover why veterinarians recommend our formula"
    },
    "cta_text": {
      "asset_type": "text",
      "content": "Learn More"
    }
  }
}
```

**Use Cases**:
- Traditional display advertising
- Pre-rendered video ads
- Static native ads
- Fixed creative campaigns

### Dynamic Manifests

Dynamic manifests include endpoints or code for real-time generation. These are produced by creative agents in **Prompt to Dynamic Rendering** mode (DCO/Generative).

```json
{
  "format_id": "display_dynamic_300x250",
  "assets": {
    "dynamic_content": {
      "asset_type": "webhook",
      "url": "https://creative-agent.example.com/render/campaign-123",
      "method": "POST",
      "timeout_ms": 500,
      "supported_macros": ["WEATHER", "TIME", "DEVICE_TYPE", "COUNTRY"],
      "response_type": "html",
      "security": {
        "method": "hmac_sha256",
        "hmac_header": "X-Signature"
      },
      "fallback_required": true
    },
    "fallback_image": {
      "asset_type": "image",
      "url": "https://cdn.example.com/fallback-300x250.jpg",
      "width": 300,
      "height": 250,
      "format": "jpg"
    }
  }
}
```

**Use Cases**:
- Weather-based creative
- Time-of-day personalization
- Product availability messaging
- Real-time inventory updates

**Note**: For client-side dynamic rendering, use `html` or `javascript` asset types with embedded tags instead of webhooks.

**Dynamic manifests can mix asset types** - some assets may be static (images, videos) while others are dynamic (webhooks, tags with macros). For example, a video VAST tag with a static hero video but a personalized end card webhook.

### DOOH Manifests with Impression Tracking

Digital Out-of-Home (DOOH) creatives use impression tracking just like other formats, but with venue-specific macros instead of device identifiers.

```json
{
  "format_id": "dooh_billboard_1920x1080",
  "promoted_offering": "Premium Coffee Blend",
  "assets": {
    "billboard_image": {
      "asset_type": "image",
      "url": "https://cdn.example.com/billboard-1920x1080.jpg",
      "width": 1920,
      "height": 1080,
      "format": "jpg"
    },
    "impression_tracker": {
      "asset_type": "url",
      "url_purpose": "impression",
      "url": "https://tracking.example.com/imp?screen={SCREEN_ID}&venue={VENUE_TYPE}&ts={PLAY_TIMESTAMP}&lat={VENUE_LAT}&lon={VENUE_LONG}"
    }
  }
}
```

**DOOH-Specific Macros** (see [Universal Macros](./universal-macros.md) for complete list):
- `{SCREEN_ID}` - Unique identifier for the physical screen
- `{VENUE_TYPE}` - Venue category (airport, mall, transit, highway, retail)
- `{VENUE_LAT}` / `{VENUE_LONG}` - Physical location coordinates
- `{PLAY_TIMESTAMP}` - When creative displayed (Unix timestamp)
- `{DWELL_TIME}` - Average viewer dwell time at this location

The mechanics are identical to digital impression tracking - a URL fires when the ad displays. The difference is DOOH uses fixed venue context instead of dynamic device identifiers.

## Working with Manifests

### Creating Manifests

Manifests are JSON structures that can be created in two ways:

**1. Manual Assembly**

Construct manifests directly by pairing format requirements with your assets:

```json
{
  "format_id": "native_responsive",
  "promoted_offering": "Premium Salmon Formula",
  "assets": {
    "hero_image": {
      "asset_type": "image",
      "url": "https://cdn.example.com/salmon-hero.jpg",
      "width": 1200,
      "height": 627
    },
    "headline": {
      "asset_type": "text",
      "content": "New Premium Salmon Formula"
    }
  }
}
```

**2. AI-Generated (Optional)**

Use `build_creative` to have a creative agent generate manifests from natural language briefs. See [Generative Creative](./generative-creative.md) for details.

### Validating Manifests

Before using a manifest, validate it against format requirements:

1. **Format Compatibility**: Ensure `format_id` matches intended format
2. **Required Assets**: All required asset roles are present
3. **Asset Specifications**: Each asset meets format requirements (dimensions, file size, etc.)
4. **Macro Support**: Dynamic manifests properly handle required macros

Creative agents that implement `build_creative` handle validation automatically. For manually constructed manifests, validate against the format specification returned by `list_creative_formats`.

### Previewing Manifests

Use the `preview_creative` task to see how a manifest will render:

```json
{
  "format_id": "native_responsive",
  "creative_manifest": {
    "format_id": "native_responsive",
    "assets": {
      "hero_image": {
        "url": "https://cdn.example.com/hero.jpg",
        "width": 1200,
        "height": 627
      },
      // ... other assets
    }
  },
  "macro_values": {
    "CLICK_URL": "https://example.com/landing",
    "CACHE_BUSTER": "12345"
  }
}
```

The creative agent returns preview URLs and renderings.

### Submitting Manifests

Manifests are submitted to the creative library using `sync_creatives`, then referenced by ID in media buys:

```json
{
  "task": "sync_creatives",
  "parameters": {
    "creatives": [
      {
        "creative_id": "native-salmon-v1",
        "name": "Salmon Special Native Ad",
        "format_id": "native_responsive",
        "manifest": {
          "format_id": "native_responsive",
          "promoted_offering": "Fresh Pacific Salmon",
          "assets": {
            "headline": {
              "asset_type": "text",
              "content": "Fresh Pacific Salmon - 20% Off Today"
            },
            "main_image": {
              "asset_type": "image",
              "url": "https://cdn.example.com/salmon.jpg",
              "width": 1200,
              "height": 628
            }
          }
        }
      }
    ]
  }
}
```

Then reference in media buys by `creative_id`. Each manifest is for a single format.

## Macro Substitution in Manifests

Manifests support macro placeholders for dynamic values. AdCP uses universal macros that work consistently across all publishers.

See [Universal Macros](./universal-macros.md) for complete documentation on available macros, macro substitution process, and format-specific macro support.


## Best Practices

### For Creative Agents

1. **Complete Manifests**: Include all required assets for the format
2. **Validate Assets**: Ensure assets meet format specifications
3. **Provide Fallbacks**: Include fallback assets for dynamic creatives
4. **Document Macros**: Clearly specify which macros are used
5. **Version Assets**: Use versioned URLs for asset management

### For Publishers

1. **Validate on Receipt**: Check manifests against format requirements
2. **Cache Assets**: Pre-fetch and cache hosted assets
3. **Handle Failures**: Implement fallback rendering for dynamic manifests
4. **Support Macros**: Implement full Universal Macro support
5. **Provide Templates**: Offer rendering templates for custom formats

### For Buyers

1. **Validate Manifests**: Ensure manifests match format requirements (manually or via `build_creative`)
2. **Preview First**: Always preview manifests before submission
3. **Test Macros**: Verify macro substitution works as expected
4. **Optimize Assets**: Ensure assets are properly sized and compressed
5. **Organize Libraries**: Use creative libraries for asset management

## Advanced Topics

### Repeatable Asset Groups

For carousel, slideshow, and multi-asset formats, see the [Carousel & Multi-Asset Formats](./channels/carousels.md) guide for complete documentation on repeatable asset groups.

## Schema Reference

- [Creative Manifest Schema](/schemas/v1/core/creative-manifest.json)
- [Preview Creative Request](/schemas/v1/creative/preview-creative-request.json)
- [Preview Creative Response](/schemas/v1/creative/preview-creative-response.json)

## Related Documentation

- [Creative Formats](./formats.md) - Understanding format specifications and discovery
- [Channel Guides](./channels/video.md) - Format examples across video, display, audio, DOOH, and carousels
- [build_creative Task](./task-reference/build_creative.md)
- [preview_creative Task](./task-reference/preview_creative.md)
