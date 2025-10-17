---
title: list_creative_formats
sidebar_position: 2
---

# list_creative_formats

Discover all creative formats supported by this agent. Returns full format definitions, not just IDs.

**Response Time**: ~1 second (simple database lookup)

**Authentication**: None required - this endpoint must be publicly accessible for format discovery

**Request Schema**: [`/schemas/v1/media-buy/list-creative-formats-request.json`](/schemas/v1/media-buy/list-creative-formats-request.json)
**Response Schema**: [`/schemas/v1/media-buy/list-creative-formats-response.json`](/schemas/v1/media-buy/list-creative-formats-response.json)

## Recursive Discovery Model

Both sales agents and creative agents use the same response format:
1. **formats**: Full format definitions for formats they own/support
2. **creative_agents** (optional): URLs to other creative agents providing additional formats

Each format includes an **agent_url** field indicating its authoritative source.

Buyers can recursively query creative_agents to discover all available formats. **Buyers must track visited URLs to avoid infinite loops.**

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `format_ids` | FormatID[] | No | Return only these specific structured format ID objects (e.g., from `get_products` response) |
| `type` | string | No | Filter by format type: `"audio"`, `"video"`, `"display"`, `"dooh"` (technical categories with distinct requirements) |
| `asset_types` | string[] | No | Filter to formats that include these asset types. For third-party tags, search for `["html"]` or `["javascript"]`. E.g., `["image", "text"]` returns formats with images and text, `["javascript"]` returns formats accepting JavaScript tags. Values: `image`, `video`, `audio`, `text`, `html`, `javascript`, `url` |
| `max_width` | integer | No | Maximum width in pixels (inclusive). Returns formats where **any render** has width ≤ this value. For multi-render formats (e.g., video with companion banner), matches if at least one render fits. |
| `max_height` | integer | No | Maximum height in pixels (inclusive). Returns formats where **any render** has height ≤ this value. For multi-render formats, matches if at least one render fits. |
| `min_width` | integer | No | Minimum width in pixels (inclusive). Returns formats where **any render** has width ≥ this value. |
| `min_height` | integer | No | Minimum height in pixels (inclusive). Returns formats where **any render** has height ≥ this value. |
| `is_responsive` | boolean | No | Filter for responsive formats that adapt to container size. When `true`, returns formats without fixed dimensions. |
| `name_search` | string | No | Search for formats by name (case-insensitive partial match, e.g., `"mobile"` or `"vertical"`) |

### Multi-Render Dimension Filtering

Formats may produce multiple rendered pieces (e.g., video + companion banner, desktop + mobile variants). Dimension filters use **"any render fits"** logic:

- **`max_width: 300, max_height: 250`** - Returns formats where AT LEAST ONE render is ≤ 300×250
- **Use case**: "Find formats that can render into my 300×250 ad slot"
- **Example**: A format with primary video (1920×1080) + companion banner (300×250) **matches** because the companion fits

This ensures you discover all formats capable of rendering into your available placement dimensions, even if they also include larger companion pieces.

## Response Structure

```json
{
  "formats": [
    {
      "format_id": {
        "agent_url": "https://sales-agent.example.com",
        "id": "video_standard_30s"
      },
      "agent_url": "https://sales-agent.example.com",
      "name": "Standard Video - 30 seconds",
      "type": "video",
      "requirements": { /* ... */ },
      "assets_required": [ /* ... */ ]
    },
    {
      "format_id": {
        "agent_url": "https://sales-agent.example.com",
        "id": "display_300x250"
      },
      "agent_url": "https://sales-agent.example.com",
      "name": "Medium Rectangle Banner",
      "type": "display"
      // ... full format details
    }
  ],
  "creative_agents": [
    {
      "agent_url": "https://creative.adcontextprotocol.org",
      "agent_name": "AdCP Reference Creative Agent",
      "capabilities": ["validation", "assembly", "preview"]
    },
    {
      "agent_url": "https://dco.example.com",
      "agent_name": "Custom DCO Platform",
      "capabilities": ["validation", "assembly", "generation", "preview"]
    }
  ]
}
```

### Field Descriptions

- **formats**: Full format definitions for formats this agent owns/supports
  - **format_id**: Unique identifier
  - **agent_url**: Authoritative source URL for this format (where it's defined)
  - All other format fields as per [Format schema](/schemas/v1/core/format.json)
- **creative_agents** (optional): Other creative agents providing additional formats
  - **agent_url**: Base URL to query for more formats (call list_creative_formats)
  - **agent_name**: Human-readable name
  - **capabilities**: What the agent can do (validation/assembly/generation/preview)


## Protocol-Specific Examples

The AdCP payload is identical across protocols. Only the request/response wrapper differs.

### Example 1: Find Formats by Asset Types

"I have images and text - what can I build?"

#### MCP Request
```json
{
  "tool": "list_creative_formats",
  "arguments": {
    "asset_types": ["image", "text"]
  }
}
```

#### Response
```json
{
  "formats": [
    {
      "format_id": {
        "agent_url": "https://sales-agent.example.com",
        "id": "display_300x250"
      },
      "agent_url": "https://sales-agent.example.com",
      "name": "Medium Rectangle",
      "type": "display",
      "dimensions": "300x250",
      "assets_required": [
        {
          "asset_id": "banner_image",
          "asset_type": "image",
          "asset_role": "hero_image",
          "required": true,
          "width": 300,
          "height": 250,
          "acceptable_formats": ["jpg", "png", "gif"],
          "max_file_size_kb": 200
        },
        {
          "asset_id": "headline",
          "asset_type": "text",
          "asset_role": "headline",
          "required": true,
          "max_length": 25
        }
      ]
    },
    {
      "format_id": {
        "agent_url": "https://sales-agent.example.com",
        "id": "native_responsive"
      },
      "agent_url": "https://sales-agent.example.com",
      "name": "Responsive Native Ad",
      "type": "display",
      "assets_required": [
        {
          "asset_id": "primary_image",
          "asset_type": "image",
          "asset_role": "hero_image",
          "required": true
        },
        {
          "asset_id": "headline",
          "asset_type": "text",
          "asset_role": "headline",
          "required": true,
          "max_length": 80
        },
        {
          "asset_id": "description",
          "asset_type": "text",
          "asset_role": "body_text",
          "required": false,
          "max_length": 200
        }
      ]
    }
  ]
}
```

### Example 2: Find Formats for Third-Party JavaScript Tags

"I have 300x250 JavaScript tags - which formats support them?"

#### MCP Request
```json
{
  "tool": "list_creative_formats",
  "arguments": {
    "asset_types": ["javascript"],
    "dimensions": "300x250"
  }
}
```

#### Response
```json
{
  "formats": [
    {
      "format_id": {
        "agent_url": "https://sales-agent.example.com",
        "id": "display_300x250_3p"
      },
      "agent_url": "https://sales-agent.example.com",
      "name": "Medium Rectangle - Third Party",
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
            "max_file_size_kb": 200
          }
        }
      ]
    }
  ]
}
```

### Example 3: Find Formats by Size

"What formats can accept HTML, JavaScript, or images up to 970x250?"

**Important**: The `asset_types` parameter uses OR logic - formats matching ANY of the specified asset types will be returned.

#### MCP Request
```json
{
  "tool": "list_creative_formats",
  "arguments": {
    "asset_types": ["html", "javascript", "image"],
    "max_width": 970,
    "max_height": 250,
    "type": "display"
  }
}
```

This query can be sent to either:
1. **Sales agent** - Returns formats the sales agent supports directly
2. **Reference creative agent** (`https://creative.adcontextprotocol.org`) - Returns all standard formats matching the criteria

The response includes all display formats at or below 970×250 that accept any of those asset types (e.g., 300×250, 728×90, 970×250).

**Example: Find responsive formats**

```json
{
  "tool": "list_creative_formats",
  "arguments": {
    "is_responsive": true,
    "type": "display"
  }
}
```

Returns formats that adapt to container width (native ads, fluid layouts, full-width banners).

### Example 4: Search by Name

"Show me mobile or vertical formats"

#### MCP Request
```json
{
  "tool": "list_creative_formats",
  "arguments": {
    "name_search": "vertical"
  }
}
```

#### Response
```json
{
  "formats": [
    {
      "format_id": {
        "agent_url": "https://sales-agent.example.com",
        "id": "video_vertical_15s"
      },
      "agent_url": "https://sales-agent.example.com",
      "name": "15-Second Vertical Video",
      "type": "video",
      "duration": "15s",
      "assets_required": [
        {
          "asset_id": "video_file",
          "asset_type": "video",
          "asset_role": "hero_video",
          "required": true,
          "requirements": {
            "duration": "15s",
            "aspect_ratio": "9:16",
            "resolution": "1080x1920",
            "format": "MP4 H.264"
          }
        }
      ]
    },
    {
      "format_id": {
        "agent_url": "https://sales-agent.example.com",
        "id": "display_vertical_mobile"
      },
      "agent_url": "https://sales-agent.example.com",
      "name": "Vertical Mobile Banner",
      "type": "display",
      "dimensions": "320x480"
    }
  ]
}
```

### Example 4: Get Specs for Specific Format IDs

"I got these format IDs from get_products - give me the full specs"

#### MCP Request
```json
{
  "tool": "list_creative_formats",
  "arguments": {
    "format_ids": [
      {
        "agent_url": "https://creatives.adcontextprotocol.org",
        "id": "video_15s_hosted"
      },
      {
        "agent_url": "https://creatives.adcontextprotocol.org",
        "id": "display_300x250"
      }
    ]
  }
}
```

#### Response
```json
{
  "formats": [
    {
      "format_id": {
        "agent_url": "https://sales-agent.example.com",
        "id": "video_15s_hosted"
      },
      "agent_url": "https://sales-agent.example.com",
      "name": "15-Second Hosted Video",
      "type": "video",
      "duration": "15s",
      "assets_required": [
        {
          "asset_id": "video_file",
          "asset_type": "video",
          "asset_role": "hero_video",
          "required": true,
          "requirements": {
            "duration": "15s",
            "format": "MP4 H.264",
            "resolution": ["1920x1080", "1280x720"],
            "max_file_size_mb": 30
          }
        }
      ]
    },
    {
      "format_id": {
        "agent_url": "https://sales-agent.example.com",
        "id": "display_300x250"
      },
      "agent_url": "https://sales-agent.example.com",
      "name": "Medium Rectangle",
      "type": "display",
      "dimensions": "300x250",
      "assets_required": [
        {
          "asset_id": "banner_image",
          "asset_type": "image",
          "asset_role": "hero_image",
          "required": true,
          "width": 300,
          "height": 250,
          "acceptable_formats": ["jpg", "png", "gif"],
          "max_file_size_kb": 200
        }
      ]
    }
  ]
}
```

### MCP Response

**Message:**
```
I found 2 audio formats available. The standard 30-second format is recommended for maximum reach across all audio inventory.
```

**Payload:**
```json
{
  "formats": [
    {
      "format_id": {
        "agent_url": "https://creative.adcontextprotocol.org",
        "id": "audio_standard_30s"
      },
      "name": "Standard Audio - 30 seconds",
      "type": "audio",
      "iab_specification": "DAAST 1.0",
      "requirements": {
        "duration": 30,
        "file_types": ["mp3", "m4a"],
        "bitrate_min": 128,
        "bitrate_max": 320
      }
    },
    {
      "format_id": {
        "agent_url": "https://creative.adcontextprotocol.org",
        "id": "display_carousel_5"
      },
      "name": "Product Carousel - 5 Items",
      "type": "display",
      "assets_required": [
        {
          "asset_type": "product_image",
          "quantity": 5,
          "requirements": {
            "width": 300,
            "height": 300,
            "file_types": ["jpg", "png"],
            "max_file_size": 150000
          }
        },
        {
          "asset_type": "logo",
          "quantity": 1,
          "requirements": {
            "width": 200,
            "height": 50,
            "file_types": ["png", "svg"]
          }
        },
        {
          "asset_type": "headline",
          "quantity": 5,
          "requirements": {
            "max_length": 25,
            "type": "text"
          }
        }
      ]
    }
  ]
}
```

### A2A Request

#### Natural Language Invocation
```javascript
await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "Show me all your supported creative formats"
    }]
  }
});
```

#### Explicit Skill Invocation
```javascript
await a2a.send({
  message: {
    parts: [{
      kind: "data",
      data: {
        skill: "list_creative_formats",
        parameters: {
          standard_only: false
        }
      }
    }]
  }
});
```

### A2A Response

```json
{
  "artifacts": [{
    "name": "creative_formats",
    "parts": [
      {
        "kind": "text",
        "text": "We support 47 creative formats across video, audio, and display. Video formats dominate with 23 options including standard pre-roll and innovative interactive formats. For maximum compatibility, I recommend using IAB standard formats which are accepted by 95% of our inventory."
      },
      {
        "kind": "data",
        "data": {
          "formats": [
            {
              "format_id": {
                "agent_url": "https://creative.adcontextprotocol.org",
                "id": "video_standard_30s"
              },
              "name": "Standard Video - 30 seconds",
              "type": "video",
              "iab_specification": "VAST 4.2",
              "requirements": {
                "duration": 30,
                "width": 1920,
                "height": 1080,
                "file_types": ["mp4", "webm"],
                "max_file_size": 50000000,
                "min_bitrate": 2500,
                "max_bitrate": 8000
              }
            }
            // ... 46 more formats
          ]
        }
      }
    ]
  }]
}
```

## Scenarios

### Discovering Standard Video Formats

**Request:**
```json
{
  "type": "video",
  "standard_only": true
}
```

**Message:**
```
Found 8 standard video formats following IAB VAST specifications. The 30-second and 15-second pre-roll formats have the broadest inventory coverage.
```

**Payload:**
```json
{
  "formats": [
    {
      "format_id": {
        "agent_url": "https://creative.adcontextprotocol.org",
        "id": "video_standard_30s"
      },
      "name": "Standard Video - 30 seconds",
      "type": "video",
      "iab_specification": "VAST 4.2",
      "requirements": {
        "duration": 30,
        "width": 1920,
        "height": 1080,
        "file_types": ["mp4", "webm"],
        "max_file_size": 50000000
      }
    },
    {
      "format_id": {
        "agent_url": "https://creative.adcontextprotocol.org",
        "id": "video_standard_15s"
      },
      "name": "Standard Video - 15 seconds",
      "type": "video",
      "iab_specification": "VAST 4.2",
      "requirements": {
        "duration": 15,
        "width": 1920,
        "height": 1080,
        "file_types": ["mp4", "webm"],
        "max_file_size": 25000000
      }
    }
    // ... 6 more standard video formats
  ]
}
```

### Finding Display Carousel Formats

**Request:**
```json
{
  "type": "display"
}
```

**Message:**
```
I found 15 display formats including standard IAB sizes and innovative formats like product carousels. Standard sizes (300x250, 728x90) have the broadest reach, while carousel formats offer higher engagement for e-commerce campaigns.
```

**Payload:**
```json
{
  "formats": [
    {
      "format_id": {
        "agent_url": "https://creative.adcontextprotocol.org",
        "id": "display_carousel_5"
      },
      "name": "Product Carousel - 5 Items",
      "type": "display",
      "assets_required": [
        {
          "asset_type": "product_image",
          "quantity": 5,
          "requirements": {
            "width": 300,
            "height": 300,
            "file_types": ["jpg", "png"]
          }
        }
      ]
    }
    // ... additional display formats
  ]
}
```

## Usage Notes

- **Primary use case**: Get creative specifications after `get_products` returns format IDs
- **Format IDs are just strings** until you get their specifications from this tool
- **Standard formats** follow IAB specifications and work across multiple publishers
- **Custom formats** (like "homepage_takeover") are publisher-specific with unique requirements  
- **The `format_ids` parameter** is the most efficient way to get specs for specific formats returned by products
- **Asset requirements vary by format type**:
  - Audio formats: duration, file types, bitrate specifications
  - Video formats: resolution, aspect ratio, codec, delivery method
  - Display formats: dimensions, file types, file size limits
  - Rich media formats: multiple assets with specific roles and requirements

## Implementation Guide

### Generating Format Messages

The `message` field should provide helpful context about available formats:

```python
def generate_formats_message(formats, filter_type=None):
    total_count = len(formats)
    standard_count = sum(1 for f in formats if f.is_standard)
    
    # Analyze format distribution
    by_type = {}
    for format in formats:
        by_type[format.type] = by_type.get(format.type, 0) + 1
    
    # Generate insights
    if filter_type:
        recommendations = get_format_recommendations(formats, filter_type)
        return f"I found {total_count} {filter_type} formats available. {recommendations}"
    else:
        type_summary = format_type_distribution(by_type)
        compatibility_note = f"For maximum compatibility, I recommend using IAB standard formats which are accepted by {calculate_standard_coverage()}% of our inventory."
        return f"We support {total_count} creative formats across {', '.join(by_type.keys())}. {type_summary} {compatibility_note}"

def get_format_recommendations(formats, format_type):
    if format_type == "video":
        return "The standard 30-second format provides the broadest reach, while 15-second formats work best for social platforms. Consider creating multiple durations to maximize inventory access."
    elif format_type == "audio":
        return "The standard 30-second format is recommended for maximum reach across all audio inventory. 15-second spots are ideal for podcasts and streaming audio."
    elif format_type == "display":
        return "Standard IAB sizes (300x250, 728x90) have the most inventory. Rich media formats like carousels drive higher engagement but have limited availability."
```