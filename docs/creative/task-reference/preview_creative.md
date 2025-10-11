---
title: preview_creative
sidebar_position: 14
---

# preview_creative

Generate preview renderings of a creative manifest in a specific format. This allows buyers and publishers to see how a creative will render in different contexts before finalizing it for campaigns.

## Quick Start

The simplest preview request returns a single URL you can iframe:

```json
{
  "format_id": "native_responsive",
  "creative_manifest": { /* your creative */ }
}
```

Response:

```json
{
  "adcp_version": "1.0.0",
  "previews": [
    {
      "preview_url": "https://creative-agent.example.com/preview/abc123",
      "input": {
        "name": "Default",
        "macros": {}
      }
    }
  ],
  "expires_at": "2025-02-15T18:00:00Z"
}
```

Embed the preview:

```html
<iframe src="https://creative-agent.example.com/preview/abc123"
        width="600" height="400"></iframe>
```

The preview URL returns an HTML page that handles all rendering (images, video players, audio players, etc.) - no client logic needed.

## Overview

Creative agents provide the ability to preview how a creative manifest will render in a given format. This is essential for:
- **Calibration**: Testing how dynamic creatives render with different inputs
- **Review**: Visual validation before campaign launch
- **Context Testing**: Simulating different user scenarios, devices, and environments
- **Quality Assurance**: Verifying creative rendering across multiple variants

To test multiple scenarios, provide an `inputs` array - you'll get one preview per input.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `format_id` | string | Yes | Format identifier for rendering |
| `creative_manifest` | object | Yes | Complete creative manifest with all required assets |
| `inputs` | array | No | Array of input sets for generating multiple preview variants |
| `template_id` | string | No | Specific template for custom format rendering |
| `brand_card` | object | No | Brand information manifest providing context for dynamic previews |
| `promoted_products` | object | No | Products/offerings being promoted - provides product context for previews |
| `asset_filters` | object | No | Filters to select specific assets from brand card (tags, asset_types, exclude_tags) |

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

**Default Behavior**: If `inputs` is not provided, you receive a single default preview. To test multiple scenarios (devices, locations, contexts), explicitly provide the `inputs` array.

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

- **previews**: Array of preview variants. One preview per input set from the request. If no inputs provided, returns a single default preview.
- **interactive_url**: Optional URL to interactive testing page with controls to switch between variants
- **expires_at**: ISO 8601 timestamp when preview links expire

### Preview Variant Structure

```typescript
{
  preview_url: string;           // URL to HTML page - can be embedded in iframe
  input: {                       // Input parameters that generated this variant
    name: string;                // Variant name (from request or auto-generated)
    macros?: object;             // Macro values applied
    context_description?: string; // Context description applied
  };
  hints?: {                      // OPTIONAL: Optimization hints (HTML still works without these)
    primary_media_type?: "image" | "video" | "audio" | "interactive";
    estimated_dimensions?: {width: number, height: number};
    estimated_duration_seconds?: number;
    contains_audio?: boolean;
    requires_interaction?: boolean;
  };
  embedding?: {                  // OPTIONAL: Security/embedding metadata
    recommended_sandbox?: string;  // e.g., "allow-scripts allow-same-origin"
    requires_https?: boolean;
    supports_fullscreen?: boolean;
    csp_policy?: string;
  };
}
```

**Key Design Points:**
- Every `preview_url` returns an **HTML page** that can be embedded in an `<iframe>`
- The HTML page handles all rendering complexity (video players, audio players, images, interactive content)
- No client-side logic needed to determine how to render different preview types
- The `input` field echoes back the parameters used, making it easy to understand what each preview shows

**Optional Fields:**
- **hints**: Optimization hints for better UX (preload video codec, size iframe appropriately). Clients MUST support HTML regardless of hints.
- **embedding**: Security metadata for safe iframe integration (sandbox policies, HTTPS requirements, CSP)

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
      "preview_url": "https://creative-agent.example.com/preview/abc123/desktop",
      "input": {
        "name": "Desktop",
        "macros": {
          "DEVICE_TYPE": "desktop",
          "CACHEBUSTER": "87654321"
        }
      }
    },
    {
      "preview_url": "https://creative-agent.example.com/preview/abc123/mobile",
      "input": {
        "name": "Mobile",
        "macros": {
          "DEVICE_TYPE": "mobile",
          "CACHEBUSTER": "87654321"
        }
      }
    },
    {
      "preview_url": "https://creative-agent.example.com/preview/abc123/tablet",
      "input": {
        "name": "Tablet",
        "macros": {
          "DEVICE_TYPE": "tablet",
          "CACHEBUSTER": "87654321"
        }
      }
    }
  ],
  "interactive_url": "https://creative-agent.example.com/preview/abc123/interactive",
  "expires_at": "2025-02-15T18:00:00Z"
}
```

Each `preview_url` returns an HTML page that renders the creative at the appropriate size and device context. Simply embed in an iframe:

```html
<iframe src="https://creative-agent.example.com/preview/abc123/desktop"
        width="1200" height="627" frameborder="0"></iframe>
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
      "preview_url": "https://creative-agent.example.com/preview/xyz789/nyc-mobile",
      "input": {
        "name": "NYC Mobile",
        "macros": {
          "COUNTRY": "US",
          "CITY": "New York",
          "DMA": "501",
          "DEVICE_TYPE": "mobile",
          "CACHEBUSTER": "12345678"
        }
      }
    },
    {
      "preview_url": "https://creative-agent.example.com/preview/xyz789/la-desktop",
      "input": {
        "name": "LA Desktop",
        "macros": {
          "COUNTRY": "US",
          "CITY": "Los Angeles",
          "DMA": "803",
          "DEVICE_TYPE": "desktop",
          "CACHEBUSTER": "12345678"
        }
      }
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
      "preview_url": "https://creative-agent.example.com/preview/audio123/weather",
      "input": {
        "name": "Weather Podcast",
        "context_description": "Podcast host discussing weather patterns and seasonal changes, transitioning to ad break",
        "macros": {
          "CONTENT_GENRE": "news",
          "CACHEBUSTER": "99887766"
        }
      }
    },
    {
      "preview_url": "https://creative-agent.example.com/preview/audio123/running",
      "input": {
        "name": "Running Podcast",
        "context_description": "Podcast about marathon training and fitness, host just finished discussing nutrition for runners",
        "macros": {
          "CONTENT_GENRE": "sports",
          "CACHEBUSTER": "99887766"
        }
      }
    },
    {
      "preview_url": "https://creative-agent.example.com/preview/audio123/morning-news",
      "input": {
        "name": "News Podcast Morning",
        "context_description": "Morning news podcast, upbeat energy, discussing daily health headlines",
        "macros": {
          "CONTENT_GENRE": "news",
          "CACHEBUSTER": "99887766"
        }
      }
    }
  ],
  "interactive_url": "https://creative-agent.example.com/preview/audio123/player",
  "expires_at": "2025-02-15T18:00:00Z"
}
```

Each `preview_url` returns an HTML page with an embedded audio player showing the AI-generated host read for that context.

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
      "preview_url": "https://creative-agent.example.com/preview/video456/us-ne",
      "input": {
        "name": "US Northeast",
        "macros": {
          "COUNTRY": "US",
          "REGION": "NY",
          "DMA": "501",
          "CACHEBUSTER": "11223344"
        }
      }
    },
    {
      "preview_url": "https://creative-agent.example.com/preview/video456/uk-london",
      "input": {
        "name": "UK London",
        "macros": {
          "COUNTRY": "GB",
          "REGION": "ENG",
          "CITY": "London",
          "CACHEBUSTER": "11223344"
        }
      }
    }
  ],
  "interactive_url": "https://creative-agent.example.com/preview/video456/player",
  "expires_at": "2025-02-15T18:00:00Z"
}
```

Each `preview_url` returns an HTML page with an embedded video player showing the geo-specific variant.

### Example 4: Using Brand Card for Dynamic Previews

Preview creative variants using brand context and product information:

```json
{
  "format_id": "native_responsive",
  "creative_manifest": {
    "format_id": "native_responsive",
    "assets": {
      "headline": {
        "asset_type": "text",
        "content": "{PRODUCT_NAME} - {TAGLINE}"
      },
      "main_image": {
        "asset_type": "image",
        "url": "{BRAND_ASSET_URL}"
      },
      "cta": {
        "asset_type": "text",
        "content": "Shop Now"
      }
    }
  },
  "brand_card": {
    "url": "https://acmecorp.com",
    "assets": [
      {
        "asset_id": "hero_holiday",
        "asset_type": "image",
        "url": "https://cdn.acmecorp.com/holiday-hero.jpg",
        "tags": ["holiday", "winter", "hero"]
      }
    ]
  },
  "promoted_products": {
    "skus": ["WIDGET-PRO-2024"]
  },
  "asset_filters": {
    "tags": ["holiday", "winter"]
  },
  "inputs": [
    {
      "name": "Holiday Desktop",
      "macros": {
        "DEVICE_TYPE": "desktop"
      },
      "context_description": "Holiday shopping season, premium product showcase"
    },
    {
      "name": "Holiday Mobile",
      "macros": {
        "DEVICE_TYPE": "mobile"
      },
      "context_description": "Mobile browsing during holiday sales"
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
      "preview_url": "https://creative-agent.example.com/preview/brand123/desktop",
      "input": {
        "name": "Holiday Desktop",
        "macros": {
          "DEVICE_TYPE": "desktop",
          "PRODUCT_NAME": "Widget Pro 2024",
          "TAGLINE": "Premium Quality You Can Trust",
          "BRAND_ASSET_URL": "https://cdn.acmecorp.com/holiday-hero.jpg"
        },
        "context_description": "Holiday shopping season, premium product showcase"
      }
    },
    {
      "preview_url": "https://creative-agent.example.com/preview/brand123/mobile",
      "input": {
        "name": "Holiday Mobile",
        "macros": {
          "DEVICE_TYPE": "mobile",
          "PRODUCT_NAME": "Widget Pro 2024",
          "TAGLINE": "Premium Quality You Can Trust",
          "BRAND_ASSET_URL": "https://cdn.acmecorp.com/holiday-hero.jpg"
        },
        "context_description": "Mobile browsing during holiday sales"
      }
    }
  ],
  "interactive_url": "https://creative-agent.example.com/preview/brand123/interactive",
  "expires_at": "2025-02-15T18:00:00Z"
}
```

### Example 5: Video Preview with Optimization Hints

Response showing optional hints and embedding metadata:

```json
{
  "adcp_version": "1.0.0",
  "previews": [
    {
      "preview_url": "https://creative-agent.example.com/preview/video789",
      "input": {
        "name": "CTV Video",
        "macros": {
          "DEVICE_TYPE": "ctv"
        }
      },
      "hints": {
        "primary_media_type": "video",
        "estimated_dimensions": {
          "width": 1920,
          "height": 1080
        },
        "estimated_duration_seconds": 30,
        "contains_audio": true,
        "requires_interaction": false
      },
      "embedding": {
        "recommended_sandbox": "allow-scripts allow-same-origin",
        "requires_https": true,
        "supports_fullscreen": true,
        "csp_policy": "default-src 'self' https://cdn.example.com"
      }
    }
  ],
  "expires_at": "2025-02-15T18:00:00Z"
}
```

**Using hints for optimization:**

```javascript
// Client can use hints to optimize iframe setup
const preview = response.previews[0];

if (preview.hints?.primary_media_type === "video") {
  // Preload video codec
  document.createElement('link').rel = 'preload';
}

if (preview.hints?.estimated_dimensions) {
  // Size iframe appropriately
  iframe.width = preview.hints.estimated_dimensions.width;
  iframe.height = preview.hints.estimated_dimensions.height;
}

if (preview.hints?.contains_audio) {
  // Warn user about autoplay policies
  showAutoplayWarning();
}
```

**Using embedding metadata for security:**

```javascript
// Apply recommended security policies
if (preview.embedding?.recommended_sandbox) {
  iframe.sandbox = preview.embedding.recommended_sandbox;
}

if (preview.embedding?.requires_https && !preview.preview_url.startsWith('https:')) {
  console.warn('Preview should be served over HTTPS');
}

if (preview.embedding?.supports_fullscreen) {
  iframe.allowFullscreen = true;
}
```

## Usage Notes

- **Preview URLs are Always HTML**: Every `preview_url` returns an HTML page that can be embedded in an iframe - no client-side rendering logic needed
- **One Preview per Input**: If you provide 3 inputs, you get 3 previews. If you provide no inputs, you get 1 default preview.
- **Input Echo**: The `input` field echoes back the parameters used to generate each preview, making it clear what each variant represents
- **Optional Hints**: Creative agents MAY provide optimization hints. Clients MUST support HTML rendering regardless of whether hints are present.
- **Optional Embedding Metadata**: Provides guidance for secure iframe integration, but clients should apply their own security policies as needed.
- **Preview Expiration**: Preview links typically expire within 24-48 hours
- **Macro Defaults**: If macro values aren't provided, creative agents use sensible defaults
- **Interactive Testing Page**: The optional `interactive_url` provides advanced testing with controls to modify macros in real-time
- **Format Requirements**: Creative manifest must include all required assets for the format

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

#### Required Implementation

1. **Return HTML Pages**: Every `preview_url` MUST return a complete HTML page that renders the creative
   ```html
   <!DOCTYPE html>
   <html>
     <head>
       <meta charset="UTF-8">
       <meta name="viewport" content="width=device-width, initial-scale=1.0">
       <title>Preview: {variant_name}</title>
     </head>
     <body style="margin:0; padding:0;">
       <!-- Creative rendering here -->
     </body>
   </html>
   ```

2. **Handle All Media Types**: Embed appropriate players within the HTML page
   - **Images**: Use `<img>` tags with appropriate sizing
   - **Video**: Embed `<video>` player or iframe VAST player
   - **Audio**: Embed `<audio>` player with controls
   - **Interactive**: Embed canvas, WebGL, or interactive HTML

3. **Echo Input Parameters**: Return the exact `input` object (with defaults filled in)

4. **One Preview per Input**: Generate exactly one preview variant per input set provided. If no inputs, generate one default preview.

5. **Validate Manifest**: Ensure all required assets for the format are present before rendering

6. **Apply Macros**: Replace macro placeholders with provided or default values

7. **Security**: Sandbox creative rendering to prevent malicious code execution
   - Implement Content Security Policy headers
   - Sanitize user-provided creative content
   - Isolate preview rendering from internal systems

8. **Performance**: Generate previews quickly (< 10 seconds for multiple variants)

9. **Expiration**: Set reasonable expiration times (24-48 hours recommended) and clean up old previews

#### Optional Enhancements

10. **Provide Hints**: Include `hints` object for client optimization
    ```json
    "hints": {
      "primary_media_type": "video",
      "estimated_dimensions": {"width": 1920, "height": 1080},
      "estimated_duration_seconds": 30,
      "contains_audio": true,
      "requires_interaction": false
    }
    ```

11. **Provide Embedding Metadata**: Include `embedding` object for security guidance
    ```json
    "embedding": {
      "recommended_sandbox": "allow-scripts allow-same-origin",
      "requires_https": true,
      "supports_fullscreen": true,
      "csp_policy": "default-src 'self' https://cdn.example.com"
    }
    ```

12. **Responsive Design**: HTML pages SHOULD adapt gracefully to different iframe sizes

13. **Accessibility**: Include ARIA labels and semantic HTML where feasible (WCAG 2.1 Level AA)

### For Buyers

When requesting previews:

1. **Simple Embedding**: Just iframe the `preview_url` - no conditional rendering logic needed
2. **Request What You Need**: Use `inputs` array to specify the exact scenarios you want to see (don't rely on default variants if you have specific needs)
3. **Check Input Echo**: Review the `input` field in each preview to confirm macros were applied as expected
4. **Share with Clients**: Preview URLs are shareable links - perfect for sending to clients for approval
5. **Test Key Scenarios**: Request previews for important device, geographic, and context combinations
6. **Use Interactive URL**: For advanced testing, the `interactive_url` lets you modify macros in real-time

### For Publishers

When integrating creative agent previews:

1. **Consistent HTML Output**: Always return HTML pages from preview URLs, regardless of creative type
2. **Responsive Design**: Preview pages should adapt to iframe dimensions appropriately
3. **Document Macros**: Specify which macros your formats support via `supported_macros` in format definitions
4. **Set Expectations**: Clarify how preview rendering may differ from production (e.g., watermarks, debug info)
5. **Interactive Testing**: Consider providing an `interactive_url` with advanced testing controls
