---
title: list_creative_formats
sidebar_position: 2
---

# list_creative_formats

Discover all supported creative formats in the system.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | No | Filter by format type (e.g., `"audio"`, `"video"`, `"display"`) |
| `standard_only` | boolean | No | Only return IAB standard formats |

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
- **is_standard**: Whether this follows IAB standards
- **iab_specification**: Name of the IAB specification (if applicable)
- **requirements**: Format-specific requirements (varies by format type)
- **assets_required**: Array of required assets for composite formats

## Protocol-Specific Examples

The AdCP payload is identical across protocols. Only the request/response wrapper differs.

### MCP Request
```json
{
  "tool": "list_creative_formats",
  "arguments": {
    "type": "audio",
    "standard_only": true
  }
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
```json
{
  "skill": "list_creative_formats",
  "input": {
    "standard_only": false
  }
}
```

### A2A Response

**Message:**
```
We support 47 creative formats across video, audio, and display. Video formats dominate with 23 options including standard pre-roll and innovative interactive formats. For maximum compatibility, I recommend using IAB standard formats which are accepted by 95% of our inventory.
```

**Artifacts:**
```json
[
  {
    "type": "application/json",
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

- Use this tool to understand what creative formats are supported before creating assets
- Standard formats follow IAB specifications for maximum compatibility
- Non-standard formats may offer enhanced features but have limited inventory
- For composite formats (like carousels), check `assets_required` for all needed components
- Requirements vary by format type:
  - Audio formats specify duration, file types, and bitrate
  - Video formats include resolution, aspect ratio, and codec requirements
  - Display formats define dimensions, file types, and size limits

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