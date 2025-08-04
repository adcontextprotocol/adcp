---
title: list_creative_formats
sidebar_position: 2
---

# list_creative_formats

Discover all supported creative formats in the system.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `context_id` | string | No | Context identifier for session persistence |
| `type` | string | No | Filter by format type (e.g., `"audio"`, `"video"`, `"display"`) |
| `standard_only` | boolean | No | Only return IAB standard formats |

## Response Format

```json
{
  "context_id": "string",
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

- **context_id**: Context identifier for session persistence
- **format_id**: Unique identifier for the format
- **name**: Human-readable format name
- **type**: Format type (e.g., `"audio"`, `"video"`, `"display"`)
- **is_standard**: Whether this follows IAB standards
- **iab_specification**: Name of the IAB specification (if applicable)
- **requirements**: Format-specific requirements (varies by format type)
- **assets_required**: Array of required assets for composite formats

## Example

### Request
```json
{
  "context_id": "ctx-media-buy-abc123",  // From previous discovery
  "type": "audio",
  "standard_only": true
}
```

### Response
```json
{
  "context_id": "ctx-media-buy-abc123",  // Server maintains context
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

## Usage Notes

- Use this tool to understand what creative formats are supported before creating assets
- Standard formats follow IAB specifications for maximum compatibility
- Non-standard formats may offer enhanced features but have limited inventory
- For composite formats (like carousels), check `assets_required` for all needed components
- Requirements vary by format type:
  - Audio formats specify duration, file types, and bitrate
  - Video formats include resolution, aspect ratio, and codec requirements
  - Display formats define dimensions, file types, and size limits