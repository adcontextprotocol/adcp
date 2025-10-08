---
title: preview_creative
sidebar_position: 14
---

# preview_creative

Generate preview renderings of a creative manifest in a specific format. This allows buyers and publishers to see how a creative will render in different contexts before finalizing it for campaigns.

## Overview

Creative agents provide the ability to preview how a creative manifest will render in a given format. This is essential for:
- **Calibration**: Testing how dynamic creatives render with different inputs
- **Review**: Visual validation before campaign launch
- **Context Testing**: Simulating different user scenarios, devices, and environments
- **Quality Assurance**: Verifying creative rendering across multiple variants

The preview can generate multiple variants showing different contexts, devices, or scenarios in a single request.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `format_id` | string | Yes | Format identifier for rendering |
| `creative_manifest` | object | Yes | Complete creative manifest with all required assets |
| `inputs` | array | No | Array of input sets for generating multiple preview variants |
| `template_id` | string | No | Specific template for custom format rendering |

### Creative Manifest Structure

The creative manifest must include all assets required by the format. See [Creative Manifests](../creative-manifests.md) for detailed specification.

```typescript
{
  format_id: string;           // Must match format_id parameter
  assets: {
    [asset_role: string]: {    // Asset role from format spec (e.g., 'hero_image', 'logo')
      asset_type: string;      // Type: image, video, audio, vast_tag, text, url, etc.
      // Type-specific properties...
    }
  };
  metadata?: {
    advertiser?: string;
    campaign?: string;
    [key: string]: any;
  };
}
```

### Inputs Array

The `inputs` array allows you to request multiple preview variants in a single call. Each input set can specify:

```typescript
{
  name: string;                      // Human-readable name (e.g., "Mobile dark mode", "Podcast weather segment")
  macros?: {                         // Macro values to apply
    [macro_name: string]: string;    // e.g., DEVICE_TYPE: "mobile", COUNTRY: "US"
  };
  context_description?: string;      // Natural language context for AI-generated content
}
```

**Macro Support**: Use any universal macro from the format's `supported_macros` list. Available macros include:
- Common: `{MEDIA_BUY_ID}`, `{CREATIVE_ID}`, `{CACHEBUSTER}`
- Device: `{DEVICE_TYPE}`, `{OS}`, `{USER_AGENT}`
- Geographic: `{COUNTRY}`, `{REGION}`, `{CITY}`, `{DMA}`
- Privacy: `{GDPR}`, `{US_PRIVACY}`, `{LIMIT_AD_TRACKING}`
- Video: `{VIDEO_ID}`, `{POD_POSITION}`, `{CONTENT_GENRE}`

**Context Description**: For dynamic or AI-generated creatives (like host-read audio ads), provide natural language context:
- `"User just searched for running shoes"`
- `"Podcast discussing weather patterns in the Pacific Northwest"`
- `"Article about electric vehicles and sustainability"`
- `"Morning commute, user listening to news"`

**Default Behavior**: If `inputs` is not provided, the creative agent will generate default preview variants (typically desktop, mobile, and tablet).

## Response Format

```json
{
  "adcp_version": "string",
  "previews": "array",
  "interactive_url": "string",
  "expires_at": "string"
}
```

### Field Descriptions

- **previews**: Array of preview variants (minimum 1)
- **interactive_url**: Optional URL to interactive page showing all variants
- **expires_at**: ISO 8601 timestamp when preview links expire

### Preview Variant Structure

```typescript
{
  name: string;                  // Variant name (matches input name or auto-generated)
  preview_url: string;           // URL to rendered preview
  preview_type: string;          // Type: "image", "video", "audio", "interactive", "html"
  description?: string;          // Description of this variant
  dimensions?: {                 // For image/video previews
    width: number;
    height: number;
  };
  duration_seconds?: number;     // For video/audio previews
  macros_used?: object;          // Actual macro values used (including defaults)
  context_applied?: string;      // Context description that was applied
}
```

## Examples

### Example 1: Basic Display Format with Multiple Devices

Request previews for desktop, mobile, and tablet:

```json
{
  "format_id": "native_responsive",
  "creative_manifest": {
    "format_id": "native_responsive",
    "assets": {
      "hero_image": {
        "asset_type": "image",
        "url": "https://cdn.example.com/hero.jpg",
        "width": 1200,
        "height": 627,
        "format": "jpg"
      },
      "headline": {
        "asset_type": "text",
        "content": "Veterinarian Recommended Nutrition"
      },
      "description": {
        "asset_type": "text",
        "content": "Real salmon as the #1 ingredient"
      },
      "cta_text": {
        "asset_type": "text",
        "content": "Learn More"
      }
    }
  },
  "inputs": [
    {
      "name": "Desktop",
      "macros": {
        "DEVICE_TYPE": "desktop"
      }
    },
    {
      "name": "Mobile",
      "macros": {
        "DEVICE_TYPE": "mobile"
      }
    },
    {
      "name": "Tablet",
      "macros": {
        "DEVICE_TYPE": "tablet"
      }
    }
  ]
}
```

Response:

```json
{
  "adcp_version": "1.0.0",
  "previews": [
    {
      "name": "Desktop",
      "preview_url": "https://creative-agent.example.com/preview/abc123/desktop.png",
      "preview_type": "image",
      "description": "Desktop rendering at 1200x627",
      "dimensions": {
        "width": 1200,
        "height": 627
      },
      "macros_used": {
        "DEVICE_TYPE": "desktop",
        "CACHEBUSTER": "87654321"
      }
    },
    {
      "name": "Mobile",
      "preview_url": "https://creative-agent.example.com/preview/abc123/mobile.png",
      "preview_type": "image",
      "description": "Mobile rendering at 375x667",
      "dimensions": {
        "width": 375,
        "height": 667
      },
      "macros_used": {
        "DEVICE_TYPE": "mobile",
        "CACHEBUSTER": "87654321"
      }
    },
    {
      "name": "Tablet",
      "preview_url": "https://creative-agent.example.com/preview/abc123/tablet.png",
      "preview_type": "image",
      "description": "Tablet rendering at 768x1024",
      "dimensions": {
        "width": 768,
        "height": 1024
      },
      "macros_used": {
        "DEVICE_TYPE": "tablet",
        "CACHEBUSTER": "87654321"
      }
    }
  ],
  "interactive_url": "https://creative-agent.example.com/preview/abc123/interactive",
  "expires_at": "2025-02-15T18:00:00Z"
}
```

### Example 2: Dynamic Creative with Context

Preview a dynamic creative with different geographic and device contexts:

```json
{
  "format_id": "display_dynamic_300x250",
  "creative_manifest": {
    "format_id": "display_dynamic_300x250",
    "assets": {
      "dynamic_endpoint": {
        "asset_type": "dynamic_endpoint",
        "url": "https://creative-agent.example.com/render/ctx-456",
        "supported_macros": ["COUNTRY", "CITY", "DEVICE_TYPE", "WEATHER"]
      },
      "fallback_image": {
        "asset_type": "image",
        "url": "https://cdn.example.com/fallback-300x250.jpg",
        "width": 300,
        "height": 250,
        "format": "jpg"
      }
    }
  },
  "inputs": [
    {
      "name": "NYC Mobile",
      "macros": {
        "COUNTRY": "US",
        "CITY": "New York",
        "DMA": "501",
        "DEVICE_TYPE": "mobile"
      }
    },
    {
      "name": "LA Desktop",
      "macros": {
        "COUNTRY": "US",
        "CITY": "Los Angeles",
        "DMA": "803",
        "DEVICE_TYPE": "desktop"
      }
    }
  ]
}
```

Response:

```json
{
  "adcp_version": "1.0.0",
  "previews": [
    {
      "name": "NYC Mobile",
      "preview_url": "https://creative-agent.example.com/preview/xyz789/nyc-mobile.png",
      "preview_type": "image",
      "description": "Mobile rendering for New York City showing local store CTA",
      "dimensions": {
        "width": 300,
        "height": 250
      },
      "macros_used": {
        "COUNTRY": "US",
        "CITY": "New York",
        "DMA": "501",
        "DEVICE_TYPE": "mobile",
        "CACHEBUSTER": "12345678"
      },
      "context_applied": "User in New York City on mobile device"
    },
    {
      "name": "LA Desktop",
      "preview_url": "https://creative-agent.example.com/preview/xyz789/la-desktop.png",
      "preview_type": "image",
      "description": "Desktop rendering for Los Angeles showing local store CTA",
      "dimensions": {
        "width": 300,
        "height": 250
      },
      "macros_used": {
        "COUNTRY": "US",
        "CITY": "Los Angeles",
        "DMA": "803",
        "DEVICE_TYPE": "desktop",
        "CACHEBUSTER": "12345678"
      },
      "context_applied": "User in Los Angeles on desktop device"
    }
  ],
  "interactive_url": "https://creative-agent.example.com/preview/xyz789/interactive",
  "expires_at": "2025-02-15T18:00:00Z"
}
```

### Example 3: AI-Generated Host Read Audio Ad

Preview an audio ad with AI-generated host reads for different podcast contexts:

```json
{
  "format_id": "audio_host_read_30s",
  "creative_manifest": {
    "format_id": "audio_host_read_30s",
    "assets": {
      "script_template": {
        "asset_type": "text",
        "content": "This episode brought to you by {{BRAND_NAME}}. {{PRODUCT_DESCRIPTION}}. Use code {{PROMO_CODE}} for 20% off."
      },
      "brand_voice": {
        "asset_type": "text",
        "content": "Friendly, enthusiastic, conversational. Target audience: health-conscious millennials."
      }
    },
    "metadata": {
      "brand_name": "VitaBoost",
      "product_description": "Premium vitamin subscription service"
    }
  },
  "inputs": [
    {
      "name": "Weather Podcast",
      "context_description": "Podcast host discussing weather patterns and seasonal changes, transitioning to ad break"
    },
    {
      "name": "Running Podcast",
      "context_description": "Podcast about marathon training and fitness, host just finished discussing nutrition for runners"
    },
    {
      "name": "News Podcast Morning",
      "context_description": "Morning news podcast, upbeat energy, discussing daily health headlines"
    }
  ]
}
```

Response:

```json
{
  "adcp_version": "1.0.0",
  "previews": [
    {
      "name": "Weather Podcast",
      "preview_url": "https://creative-agent.example.com/preview/audio123/weather.mp3",
      "preview_type": "audio",
      "description": "AI-generated host read with weather-related transition",
      "duration_seconds": 30,
      "context_applied": "Podcast host discussing weather patterns and seasonal changes, transitioning to ad break",
      "macros_used": {
        "CONTENT_GENRE": "news",
        "CACHEBUSTER": "99887766"
      }
    },
    {
      "name": "Running Podcast",
      "preview_url": "https://creative-agent.example.com/preview/audio123/running.mp3",
      "preview_type": "audio",
      "description": "AI-generated host read emphasizing nutrition and performance",
      "duration_seconds": 30,
      "context_applied": "Podcast about marathon training and fitness, host just finished discussing nutrition for runners",
      "macros_used": {
        "CONTENT_GENRE": "sports",
        "CACHEBUSTER": "99887766"
      }
    },
    {
      "name": "News Podcast Morning",
      "preview_url": "https://creative-agent.example.com/preview/audio123/morning-news.mp3",
      "preview_type": "audio",
      "description": "AI-generated host read with upbeat morning energy",
      "duration_seconds": 30,
      "context_applied": "Morning news podcast, upbeat energy, discussing daily health headlines",
      "macros_used": {
        "CONTENT_GENRE": "news",
        "CACHEBUSTER": "99887766"
      }
    }
  ],
  "interactive_url": "https://creative-agent.example.com/preview/audio123/player",
  "expires_at": "2025-02-15T18:00:00Z"
}
```

### Example 4: Video with Multiple Geographic Contexts

Preview a video creative with geo-specific end cards:

```json
{
  "format_id": "video_30s_vast",
  "creative_manifest": {
    "format_id": "video_30s_vast",
    "assets": {
      "vast_tag": {
        "asset_type": "vast_tag",
        "content": "<?xml version=\"1.0\"?><VAST version=\"4.2\">...</VAST>",
        "vast_version": "4.2"
      }
    }
  },
  "inputs": [
    {
      "name": "US Northeast",
      "macros": {
        "COUNTRY": "US",
        "REGION": "NY",
        "DMA": "501"
      }
    },
    {
      "name": "UK London",
      "macros": {
        "COUNTRY": "GB",
        "REGION": "ENG",
        "CITY": "London"
      }
    }
  ]
}
```

Response:

```json
{
  "adcp_version": "1.0.0",
  "previews": [
    {
      "name": "US Northeast",
      "preview_url": "https://creative-agent.example.com/preview/video456/us-ne.mp4",
      "preview_type": "video",
      "description": "Video with US-specific end card and call-to-action",
      "dimensions": {
        "width": 1920,
        "height": 1080
      },
      "duration_seconds": 30,
      "macros_used": {
        "COUNTRY": "US",
        "REGION": "NY",
        "DMA": "501",
        "CACHEBUSTER": "11223344"
      }
    },
    {
      "name": "UK London",
      "preview_url": "https://creative-agent.example.com/preview/video456/uk-london.mp4",
      "preview_type": "video",
      "description": "Video with UK-specific end card and call-to-action",
      "dimensions": {
        "width": 1920,
        "height": 1080
      },
      "duration_seconds": 30,
      "macros_used": {
        "COUNTRY": "GB",
        "REGION": "ENG",
        "CITY": "London",
        "CACHEBUSTER": "11223344"
      }
    }
  ],
  "interactive_url": "https://creative-agent.example.com/preview/video456/player",
  "expires_at": "2025-02-15T18:00:00Z"
}
```

## Usage Notes

- **Preview Expiration**: Preview links typically expire within 24-48 hours
- **Macro Defaults**: If macro values aren't provided, creative agents use sensible defaults
- **Interactive Previews**: Allow testing different macro values and contexts in real-time
- **Format Requirements**: Creative manifest must include all required assets for the format
- **Asset Validation**: Creative agent validates assets against format specifications before rendering
- **Multiple Variants**: Request multiple input sets to see how creatives adapt to different contexts

## Use Cases

### Device Preview Variants

Test responsive designs across devices:
```json
"inputs": [
  {"name": "Desktop", "macros": {"DEVICE_TYPE": "desktop"}},
  {"name": "Mobile", "macros": {"DEVICE_TYPE": "mobile"}},
  {"name": "CTV", "macros": {"DEVICE_TYPE": "ctv"}}
]
```

### Dark/Light Mode Variants

For formats supporting appearance modes:
```json
"inputs": [
  {"name": "Light mode", "macros": {"APPEARANCE": "light"}},
  {"name": "Dark mode", "macros": {"APPEARANCE": "dark"}}
]
```

### Geographic Variants

Test location-specific creative elements:
```json
"inputs": [
  {"name": "NYC", "macros": {"CITY": "New York", "DMA": "501"}},
  {"name": "LA", "macros": {"CITY": "Los Angeles", "DMA": "803"}},
  {"name": "Chicago", "macros": {"CITY": "Chicago", "DMA": "602"}}
]
```

### AI-Generated Content Variants

For dynamic audio or text generation:
```json
"inputs": [
  {
    "name": "Morning commute",
    "context_description": "User commuting to work, listening to news"
  },
  {
    "name": "Evening relaxation",
    "context_description": "User relaxing at home after work"
  }
]
```

### Privacy Compliance Testing

Test creative behavior with different privacy settings:
```json
"inputs": [
  {"name": "Full consent", "macros": {"GDPR": "1", "GDPR_CONSENT": "CPc7TgP..."}},
  {"name": "No consent", "macros": {"GDPR": "1", "GDPR_CONSENT": ""}},
  {"name": "LAT enabled", "macros": {"LIMIT_AD_TRACKING": "1"}}
]
```

## Implementation Considerations

### For Creative Agents

Creative agents implementing `preview_creative` should:

1. **Validate Manifest**: Ensure all required assets for the format are present
2. **Apply Macros**: Replace macro placeholders with provided or default values
3. **Generate Multiple Variants**: Support rendering multiple input sets efficiently
4. **Context-Aware Generation**: For AI-generated content, use context descriptions to inform generation
5. **Handle Formats**: Support both standard AdCP formats and custom publisher formats
6. **Security**: Sandbox rendering to prevent malicious creative code execution
7. **Performance**: Generate previews quickly (< 10 seconds for multiple variants)
8. **Expiration**: Set reasonable expiration times and clean up old previews

### For Buyers

When requesting previews:

1. **Test Key Scenarios**: Use `inputs` array to test important device, geographic, and context combinations
2. **Verify Macros**: Check that macro substitution works as expected
3. **Review Quality**: Ensure creative renders correctly across all variants
4. **Check Performance**: Verify load times and file sizes are acceptable
5. **Brand Safety**: Confirm creative meets brand guidelines in all contexts
6. **Privacy Compliance**: Test with different privacy macro values to ensure compliant behavior

### For Publishers

When integrating creative agent previews:

1. **Provide Templates**: Offer template IDs for custom format rendering
2. **Document Macros**: Specify which macros your formats support via `supported_macros` in format definitions
3. **Set Expectations**: Clarify how preview rendering may differ from production
4. **Support Testing**: Enable buyers to test with representative macro values
5. **Context Documentation**: Explain what context information is available at impression time
