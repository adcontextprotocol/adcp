# Generative Creative

The Creative Protocol enables AI-powered creative generation and asset management for advertising campaigns. This guide will help you create your first creative in 5 minutes.

## Overview

The Creative Protocol provides two main capabilities:

- **`build_creative`**: Generate creative content using AI with either static manifests or dynamic code
- **`manage_creative_library`**: Organize and search creative assets with intelligent tagging

## Quick Start: Generate Your First Creative

### Step 1: Basic Creative Generation

Here's the simplest possible request to generate a native display ad:

```json
{
  "message": "Create a simple ad for a coffee shop promotion - 20% off all drinks this week",
  "format_id": "display_native",
  "output_mode": "manifest"
}
```

### Step 2: Understanding the Response

You'll receive a structured creative manifest:

```json
{
  "adcp_version": "1.6.0",
  "context_id": "ctx-coffee-123",
  "creative": {
    "format": {
      "id": "display_native",
      "name": "Native Display Ad",
      "type": "display"
    },
    "output_mode": "manifest",
    "assets": [
      {
        "asset_id": "headline_001",
        "asset_role": "headline",
        "type": "text",
        "content": "20% Off All Drinks This Week!"
      },
      {
        "asset_id": "description_001", 
        "asset_role": "description",
        "type": "text",
        "content": "Visit our cozy coffee shop and enjoy premium coffee at an unbeatable price."
      },
      {
        "asset_id": "cta_001",
        "asset_role": "call_to_action",
        "type": "text", 
        "content": "Visit Today"
      }
    ]
  }
}
```

### Step 3: Refine Your Creative

Use the `context_id` to make improvements:

```json
{
  "message": "Make the headline more exciting and add urgency",
  "context_id": "ctx-coffee-123",
  "output_mode": "manifest"
}
```

## Common Patterns

### Using Your Own Assets

Provide existing assets to incorporate into the creative:

```json
{
  "message": "Create a display ad featuring our signature latte",
  "format_id": "display_300x250",
  "assets": [
    {
      "asset_id": "brand_logo",
      "type": "image",
      "url": "https://mycoffeeshop.com/assets/logo.png",
      "tags": ["brand", "logo"]
    }
  ],
  "output_mode": "manifest"
}
```

### Generating Dynamic Code

For real-time personalization, use code mode:

```json
{
  "message": "Create a weather-responsive coffee ad that shows hot drinks when cold, iced drinks when warm",
  "format_id": "display_native",
  "output_mode": "code"
}
```

## Format Discovery

### Standard Formats

Common format IDs you can use immediately:
- `display_native` - Native advertising format
- `display_300x250` - Medium rectangle banner
- `video_standard_30s` - 30-second video ad

### Publisher-Specific Formats

For custom publisher formats, specify the source:

```json
{
  "message": "Create a premium video ad",
  "format_source": "https://premium-publisher.com/.well-known/adcp/sales",
  "format_id": "premium_video_15s",
  "output_mode": "manifest"
}
```

## Asset Library Management

### Organizing Assets

Tag your assets for easy discovery:

```json
{
  "action": "upload",
  "asset": {
    "type": "image",
    "url": "https://brand.com/summer-menu.jpg",
    "tags": ["seasonal", "summer", "menu", "photography"],
    "metadata": {
      "campaign": "summer_2024",
      "dimensions": {"width": 1200, "height": 800}
    }
  }
}
```

### Searching Assets

Find assets using natural language:

```json
{
  "action": "search", 
  "query": "summer beverage photos for social media",
  "filters": {
    "asset_types": ["image"],
    "tags": ["summer", "beverages"]
  }
}
```

## Next Steps

- **Browse Examples**: See [Task Reference](task-reference/build_creative.md) for detailed examples
- **Learn Advanced Features**: Explore real-time inference and dynamic creative generation
- **Integration Guide**: Learn how to integrate with your existing creative workflows
- **Best Practices**: Asset organization and creative optimization strategies

## Common Issues

### Format Not Found
If you get a format error, the publisher may not support that format. Try:
1. Use a standard AdCP format first (`display_native`, `video_standard_30s`)
2. Check the publisher's `list_creative_formats` endpoint
3. Verify the `format_source` URL is correct

### Creative Quality Issues
To improve creative output:
1. Be more specific in your message: "Create a minimalist coffee ad with earth tones"
2. Provide brand guidelines in the request
3. Use the conversational refinement feature to iterate

### Asset Library Organization
For better asset management:
1. Use consistent tagging conventions
2. Include campaign and date information
3. Add descriptive metadata for easier searching

Ready to create your first creative? Start with the basic example above and explore from there!