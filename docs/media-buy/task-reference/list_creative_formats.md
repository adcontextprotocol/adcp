---
title: list_creative_formats
sidebar_position: 2
---

# list_creative_formats

Discover all supported creative formats in the system. 

**See [Creative Lifecycle](../creatives/index.md) for the complete workflow on how this tool works with `get_products` for format discovery.**

**Response Time**: ~1 second (simple database lookup)

**Request Schema**: [`/schemas/v1/media-buy/list-creative-formats-request.json`](/schemas/v1/media-buy/list-creative-formats-request.json)  
**Response Schema**: [`/schemas/v1/media-buy/list-creative-formats-response.json`](/schemas/v1/media-buy/list-creative-formats-response.json)

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | No | Filter by format type (e.g., `"audio"`, `"video"`, `"display"`) |
| `category` | string | No | Filter by category (`"standard"` or `"custom"`) |
| `standard_only` | boolean | No | Only return standard formats (deprecated, use `category: "standard"`) |
| `format_ids` | string[] | No | Filter by specific format IDs (e.g., from `get_products` response) |

## Response (Message)

The response includes a human-readable message that:
- Summarizes available formats (e.g., "Found 47 creative formats across video, audio, and display")
- Provides recommendations for format selection
- Highlights standard vs custom format trade-offs

The message is returned differently in each protocol:
- **MCP**: Returned as a `message` field in the JSON response
- **A2A**: Returned as a text part in the artifact

## Response (Payload)

```json
{
  "formats": [
    {
      "format_id": "string",
      "name": "string",
      "type": "string",
      "is_standard": "boolean",
      "iab_specification": "string",
      "requirements": "object",
      "assets_required": "array"
    }
  ]
}
```

### Field Descriptions

- **format_id**: Unique identifier for the format
- **name**: Human-readable format name
- **type**: Format type (e.g., `"audio"`, `"video"`, `"display"`)
- **category**: Format category (`"standard"` or `"custom"`)
- **is_standard**: Whether this follows IAB or AdCP standards
- **accepts_3p_tags**: Whether format can accept third-party tags
- **requirements**: Format-specific requirements (varies by format type)
- **assets_required**: Array of required assets with `asset_role` identifiers


## Protocol-Specific Examples

The AdCP payload is identical across protocols. Only the request/response wrapper differs.

### Example 1: Standard Formats Only

#### MCP Request
```json
{
  "tool": "list_creative_formats",
  "arguments": {
    "category": "standard"
  }
}
```

#### Response
```json
{
  "formats": [
    {
      "format_id": "display_300x250",
      "name": "Medium Rectangle",
      "type": "display",
      "category": "standard",
      "is_standard": true,
      "dimensions": "300x250",
      "accepts_3p_tags": false,
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
          "asset_id": "clickthrough_url",
          "asset_type": "url",
          "asset_role": "clickthrough_url",
          "required": true
        }
      ]
    },
    {
      "format_id": "video_skippable_15s",
      "name": "15-Second Skippable Video",
      "type": "video",
      "category": "standard",
      "is_standard": true,
      "duration": "15s",
      "accepts_3p_tags": true,
      "requirements": {
        "aspect_ratios": ["16:9", "9:16", "1:1"],
        "max_file_size_mb": 30,
        "codec": "H.264"
      }
    }
  ]
}
```

### Example 2: Filter by Type

#### MCP Request
```json
{
  "tool": "list_creative_formats",
  "arguments": {
    "type": "audio",
    "standard_only": true
  }
}
```

### Example 3: Reverse Workflow (Product-First)

#### MCP Request - Get specs for specific format IDs
```json
{
  "tool": "list_creative_formats",
  "arguments": {
    "format_ids": ["video_15s_hosted", "video_30s_vast", "display_300x250"]
  }
}
```

#### MCP Response
```json
{
  "message": "Found 3 specific formats. These are the exact creative requirements for your available inventory.",
  "formats": [
    {
      "format_id": "video_15s_hosted",
      "name": "15-Second Hosted Video",
      "type": "video",
      "category": "standard",
      "duration": "15s",
      "accepts_3p_tags": false,
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
      "format_id": "video_30s_vast",
      "name": "30-Second VAST Video", 
      "type": "video",
      "category": "standard",
      "duration": "30s",
      "accepts_3p_tags": true,
      "delivery": {
        "method": "VAST",
        "versions": ["3.0", "4.0", "4.1", "4.2"]
      }
    },
    {
      "format_id": "display_300x250",
      "name": "Medium Rectangle",
      "type": "display",
      "category": "standard",
      "dimensions": "300x250",
      "accepts_3p_tags": false,
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
      "format_id": "audio_standard_30s",
      "name": "Standard Audio - 30 seconds", 
      "type": "audio",
      "is_standard": true,
      "iab_specification": "DAAST 1.0",
      "requirements": {
        "duration": 30,
        "file_types": ["mp3", "m4a"],
        "bitrate_min": 128,
        "bitrate_max": 320
      }
    },
    {
      "format_id": "display_carousel_5",
      "name": "Product Carousel - 5 Items",
      "type": "display",
      "is_standard": false,
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
              "format_id": "video_standard_30s",
              "name": "Standard Video - 30 seconds",
              "type": "video",
              "is_standard": true,
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
      "format_id": "video_standard_30s",
      "name": "Standard Video - 30 seconds",
      "type": "video",
      "is_standard": true,
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
      "format_id": "video_standard_15s",
      "name": "Standard Video - 15 seconds",
      "type": "video",
      "is_standard": true,
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
      "format_id": "display_carousel_5",
      "name": "Product Carousel - 5 Items",
      "type": "display",
      "is_standard": false,
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