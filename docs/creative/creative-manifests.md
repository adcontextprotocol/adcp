---
title: Creative Manifests
sidebar_position: 4
---

# Creative Manifests

Creative manifests are structured specifications that define all the assets and metadata needed to render a creative in a specific format. They serve as the bridge between creative agents that generate content and systems that deliver it.

## Overview

A creative manifest is a complete, self-contained description of a creative that includes:
- **Format identification**: Which format this creative is for
- **Asset definitions**: All required and optional assets with their locations
- **Metadata**: Campaign, advertiser, and other contextual information

Creative manifests are protocol-agnostic and can be used across different advertising systems.

## Relationship to Creative Formats

### Creative Formats Define Requirements

Creative formats specify what a creative needs to include:

```json
{
  "format_id": "display_300x250",
  "name": "Medium Rectangle Banner",
  "assets_required": [
    {
      "asset_id": "banner_image",
      "asset_type": "image",
      "required": true,
      "width": 300,
      "height": 250,
      "acceptable_formats": ["jpg", "png", "gif"],
      "max_file_size_kb": 200
    }
  ]
}
```

### Creative Manifests Fulfill Requirements

Creative manifests provide the actual assets that meet those requirements:

```json
{
  "format_id": "display_300x250",
  "promoted_offering": "Premium Widget Pro",
  "assets": {
    "banner_image": {
      "asset_type": "image",
      "url": "https://cdn.example.com/banner.jpg",
      "width": 300,
      "height": 250,
      "format": "jpg",
      "file_size": 180000
    }
  }
}
```

### What Creative Agents Do

Creative agents transform inputs into creatives that can be trafficked. The transformation type is independent of where creatives are stored.

#### Transformation Types

**1. Validation & Enrichment**: Manifest → Validated Manifest
- Buyer provides complete creative manifest
- Agent validates compliance, generates preview
- Returns validated manifest ready for use
- **Example**: Native ad manifest → validates image dimensions → adds preview URL

**2. Static Assembly**: Assets → Manifest/Tag/Webhook
- Buyer provides individual assets (images, videos, text)
- Agent packages into format-compliant output
- Output can be manifest, HTML/JS tag, or webhook endpoint
- **Example**: banner.jpg + headline → display_300x250 manifest OR `<script>` tag OR webhook URL

**3. Generative Creation**: Prompt/Brief → Manifest/Tag/Webhook
- Buyer provides natural language brief or unstructured brand assets
- Agent generates assets and packages into format
- Output can be manifest, tag, or webhook
- **Example**: "Running shoe banner" + brand assets → generates image → returns as manifest OR tag OR webhook

The key insight: **transformation type (what you do) is separate from output format (manifest/tag/webhook) and storage location (buyer-managed vs agent-managed).**

## Manifest Structure

### Basic Structure

```typescript
{
  format_id: string;           // Format this manifest is for
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

### Hybrid Manifests

Hybrid manifests combine static and dynamic elements:

```json
{
  "format_id": "video_30s_vast",
  "assets": {
    "vast_tag": {
      "asset_type": "vast_tag",
      "content": "<?xml version=\"1.0\"?><VAST version=\"4.2\">...</VAST>",
      "vast_version": "4.2",
      "duration_seconds": 30
    },
    "companion_banner": {
      "asset_type": "image",
      "url": "https://cdn.example.com/companion-300x250.jpg",
      "width": 300,
      "height": 250,
      "format": "jpg"
    },
    "end_card": {
      "asset_type": "webhook",
      "url": "https://creative-agent.example.com/endcard?campaign=123",
      "method": "GET",
      "timeout_ms": 300,
      "supported_macros": ["COUNTRY", "DEVICE_TYPE"],
      "response_type": "html",
      "security": {
        "method": "api_key",
        "api_key_header": "X-API-Key"
      }
    }
  }
}
```

**Use Cases**:
- Video with personalized end cards
- Native ads with dynamic pricing
- Carousel ads with real-time product feeds

## Working with Manifests

### Building Manifests

Creative agents build manifests through the `build_creative` task:

```json
{
  "message": "Create a native ad promoting our new salmon formula",
  "format_id": "native_responsive",
  "output_mode": "manifest",
  "assets": [
    {
      "library_id": "brand_assets",
      "tags": ["salmon", "premium"]
    }
  ]
}
```

The creative agent responds with a complete manifest:

```json
{
  "status": "ready",
  "creative_output": {
    "type": "creative_manifest",
    "format_id": "native_responsive",
    "assets": {
      "hero_image": {
        "url": "https://cdn.example.com/salmon-hero.jpg",
        "width": 1200,
        "height": 627
      },
      // ... other assets
    }
  }
}
```

### Validating Manifests

Before using a manifest, validate it against format requirements:

1. **Format Compatibility**: Ensure `format_id` matches intended format
2. **Required Assets**: All required asset roles are present
3. **Asset Specifications**: Each asset meets format requirements (dimensions, file size, etc.)
4. **Macro Support**: Dynamic manifests properly handle required macros

Creative agents handle validation automatically when building manifests.

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

Manifests are submitted through the media buy protocol:

#### During Campaign Creation

```json
{
  "task": "create_media_buy",
  "parameters": {
    "formats_to_provide": [
      {
        "format_id": "native_responsive",
        "creative_manifest": {
          "format_id": "native_responsive",
          "assets": {
            // ... manifest assets
          }
        }
      }
    ]
  }
}
```

#### Via Creative Library

```json
{
  "task": "manage_creative_library",
  "parameters": {
    "action": "add",
    "creatives": [
      {
        "creative_id": "native-salmon-v1",
        "format_id": "native_responsive",
        "manifest": {
          "format_id": "native_responsive",
          "assets": {
            // ... manifest assets
          }
        }
      }
    ]
  }
}
```

## Multi-Format Manifests

For campaigns spanning multiple placements, provide manifests for each format:

```json
{
  "formats_to_provide": [
    {
      "format_id": "display_300x250",
      "creative_manifest": {
        "format_id": "display_300x250",
        "assets": {
          "banner_image": {
            "url": "https://cdn.example.com/banner-300x250.jpg",
            "width": 300,
            "height": 250
          }
        }
      }
    },
    {
      "format_id": "video_30s_hosted",
      "creative_manifest": {
        "format_id": "video_30s_hosted",
        "assets": {
          "video_file": {
            "url": "https://cdn.example.com/video-30s.mp4",
            "width": 1920,
            "height": 1080
          }
        }
      }
    }
  ]
}
```

## Macro Substitution in Manifests

Manifests support macro placeholders for dynamic values. AdCP uses universal macros that work consistently across all publishers.

```json
{
  "format_id": "display_300x250",
  "assets": {
    "banner_html": {
      "asset_type": "html",
      "content": "<a href=\"{CLICK_URL}\"><img src=\"https://cdn.example.com/banner.jpg?cb={CACHEBUSTER}\" /></a>"
    },
    "impression_pixel": {
      "asset_type": "url",
      "url_type": "impression_tracker",
      "url": "https://track.example.com/imp?buy={MEDIA_BUY_ID}&device={DEVICE_ID}&country={COUNTRY}&cb={CACHEBUSTER}"
    }
  }
}
```

### Available Macros

Each format defines which macros it supports via the `supported_macros` field. Common categories include:

**Common Macros** (all formats):
- `{MEDIA_BUY_ID}`, `{CREATIVE_ID}`, `{CACHEBUSTER}`, `{TIMESTAMP}`

**Device & Environment**:
- `{DEVICE_TYPE}`, `{OS}`, `{USER_AGENT}`, `{APP_BUNDLE}`

**Geographic**:
- `{COUNTRY}`, `{REGION}`, `{CITY}`, `{DMA}`, `{LAT}`, `{LONG}`

**Privacy & Compliance**:
- `{GDPR}`, `{GDPR_CONSENT}`, `{US_PRIVACY}`, `{LIMIT_AD_TRACKING}`

**Video-Specific**:
- `{VIDEO_ID}`, `{POD_POSITION}`, `{CONTENT_GENRE}`, `{PLAYER_WIDTH}`

**Web Context**:
- `{DOMAIN}`, `{PAGE_URL}`, `{REFERRER}`, `{KEYWORDS}`

Query `list_creative_formats` to see which macros each format supports.

### Macro Substitution Process

1. **Creative Agent**: Includes macro placeholders in manifest assets
2. **Sales Agent**: Translates universal macros to publisher's ad server syntax during trafficking
3. **Publisher Ad Server**: Replaces macros with actual values at impression time

Example flow:
```
Creative: {DEVICE_ID}
  ↓
Sales Agent translates to: %%ADVERTISING_IDENTIFIER_PLAIN%% (for GAM)
  ↓
Ad Server substitutes: ABC-123-DEF-456
```

## Creative Storage Patterns

Where creatives are stored is independent of what transformations the creative agent performs. There are two storage patterns:

### Buyer-Managed Storage

Buyer stores and manages creative assets/manifests themselves. Agent provides transformation services on-demand.

**How it works:**
1. Buyer maintains their own asset library or creative management system
2. When needed, buyer calls creative agent with assets/manifest/prompt
3. Agent transforms and returns result (manifest, tag, or webhook)
4. Buyer stores the result in their system
5. Buyer passes creative to publisher during create_media_buy

**Agent provides:**
- `preview_creative` - Validate/preview on-demand
- `build_creative` - Transform assets/prompts into creatives on-demand
- Returns manifests, tags, or webhooks immediately
- No persistent storage of buyer's creatives

**Example:** Publisher offers native ad validation agent. Buyer has CMS with native ad templates. For each campaign, buyer generates manifest from CMS, sends to agent for validation/preview, gets back validated manifest, uses in create_media_buy.

### Agent-Managed Storage

Creative agent maintains a library of buyer's creatives. Buyer can retrieve them by ID.

**How it works:**
1. Buyer registers brand assets with agent (`manage_creative_library`)
2. Buyer builds creatives, agent stores them with creative_id
3. Buyer retrieves creatives later by ID in different formats
4. Agent serves creative as manifest, tag, or webhook depending on publisher needs

**Agent provides:**
- `preview_creative` - Full preview capabilities
- `build_creative` - Generate and store creatives
- `manage_creative_library` - Add/update/delete/list creatives
- `get_creative` - Retrieve by ID as manifest, tag, or webhook
- Persistent storage of all buyer creatives

**Example:** Independent DCO platform. Buyer uploads brand assets once. Generates 50 creative variants for different audiences. Stores all in agent library. For Publisher A (supports manifests), retrieves as manifest. For Publisher B (requires VAST tags), retrieves same creative as VAST tag. For Publisher C (wants DCO), retrieves as webhook.

### Key Difference

| Aspect | Buyer-Managed | Agent-Managed |
|--------|---------------|---------------|
| Storage | Buyer's system | Agent's system |
| Retrieval | Not applicable | By creative_id |
| Reuse | Buyer handles | Agent provides multiple formats |
| Library tasks | ❌ | ✅ (`manage_creative_library`) |
| Transformation tasks | ✅ | ✅ |
| Multi-publisher | Buyer's responsibility | Agent handles format conversion |

**Both patterns support all transformation types** (validation, static assembly, generative creation).

**Both patterns can output** manifests, tags, or webhooks.

The difference is simply: **who stores the creative after it's created?**

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

1. **Build Through Agents**: Use creative agents to generate compliant manifests
2. **Preview First**: Always preview manifests before submission
3. **Test Macros**: Verify macro substitution works as expected
4. **Optimize Assets**: Ensure assets are properly sized and compressed
5. **Organize Libraries**: Use creative libraries for asset management

## Advanced Topics

### Frame-Based Manifests

Some formats (carousels, slideshows) use frame-based structures:

```json
{
  "format_id": "retail_product_carousel",
  "assets": {
    "frames": [
      {
        "product_image": {
          "url": "https://cdn.example.com/product1.jpg",
          "width": 300,
          "height": 300
        },
        "product_name": {
          "content": "Product Name 1"
        },
        "product_price": {
          "content": "$29.99"
        }
      },
      {
        "product_image": {
          "url": "https://cdn.example.com/product2.jpg",
          "width": 300,
          "height": 300
        },
        "product_name": {
          "content": "Product Name 2"
        },
        "product_price": {
          "content": "$39.99"
        }
      }
    ],
    "logo": {
      "url": "https://cdn.example.com/brand-logo.png",
      "width": 200,
      "height": 50
    },
    "cta_text": {
      "content": "Shop Now"
    }
  }
}
```

### Third-Party Tags

Manifests can include third-party tags for external ad serving:

```json
{
  "format_id": "display_300x250",
  "assets": {
    "third_party_tag": {
      "content": "<script src=\"https://adserver.example.com/ad.js\"></script>"
    }
  },
  "metadata": {
    "is_third_party": true,
    "tag_type": "javascript"
  }
}
```

### Localization

Manifests can specify localized assets:

```json
{
  "format_id": "native_responsive",
  "assets": {
    "headline": {
      "content": "Premium Quality You Can Trust",
      "localizations": {
        "es": "Calidad Premium en la que Puede Confiar",
        "fr": "Qualité Premium en laquelle Vous Pouvez Avoir Confiance"
      }
    }
  }
}
```

## Schema Reference

- [Creative Manifest Schema](/schemas/v1/core/creative-manifest.json)
- [Preview Creative Request](/schemas/v1/creative/preview-creative-request.json)
- [Preview Creative Response](/schemas/v1/creative/preview-creative-response.json)

## Related Documentation

- [Creative Formats](../media-buy/capability-discovery/creative-formats.md)
- [Standard Creative Agent](./standard-creative-agent.md)
- [build_creative Task](./task-reference/build_creative.md)
- [preview_creative Task](./task-reference/preview_creative.md)
