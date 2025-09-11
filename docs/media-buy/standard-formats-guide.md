---
title: Standard Formats Guide
---

# Standard Formats Guide

This guide explains AdCP's standard ad formats, how to use them, and best practices for implementation.

## Overview

Standard formats are pre-defined, industry-standard creative specifications that work consistently across multiple publishers and platforms. They provide a common foundation for creative assets while allowing publishers to differentiate through placement, data, and optimization.

### Why Standard Formats Matter

1. **Simplified Creative Production**: One creative package works across multiple publishers
2. **Reduced Complexity**: No platform-specific variations or complex selection logic
3. **Faster Campaign Launch**: Pre-tested formats with known requirements
4. **Better Interoperability**: Consistent asset specifications across the ecosystem
5. **Focus on Performance**: Spend time optimizing, not adapting creatives

## Core Concepts

### Format Structure

Each standard format is a self-contained specification with:

- **format_id**: Unique identifier (e.g., `display_300x250`)
- **type**: Media type (`display`, `video`, `native`, `retail`)
- **category**: `standard` for AdCP-defined formats
- **assets_required**: Array of required creative assets
- **accepts_3p_tags**: Whether third-party tags are accepted

### Asset Roles

Every asset in a format has a specific role identified by the `asset_role` field:

```json
{
  "asset_role": "hero_image",  // Identifies the purpose
  "asset_type": "image",
  "width": 1200,
  "height": 627
}
```

Common asset roles:
- `hero_image`: Primary visual element
- `logo`: Brand identifier
- `headline`: Primary text message
- `cta_button`: Call-to-action element
- `background_video`: Ambient video content

### Format Categories

Standard formats are organized into categories:

1. **Display**: Traditional banner formats (300x250, 728x90, etc.)
2. **Video**: Time-based video content (15s, 30s, vertical)
3. **Native**: Content-integrated formats (responsive, feed-based)
4. **Retail**: Commerce-specific formats (product carousels)
5. **Foundational**: Universal formats that work everywhere

## Available Standard Formats

### Display Formats

#### display_300x250
Standard medium rectangle banner
- **Dimensions**: 300x250 pixels
- **Assets**: Banner image, clickthrough URL
- **Max file size**: 200KB

#### display_728x90
Leaderboard banner
- **Dimensions**: 728x90 pixels
- **Assets**: Banner image, clickthrough URL
- **Max file size**: 200KB

#### display_160x600
Wide skyscraper
- **Dimensions**: 160x600 pixels
- **Assets**: Banner image, clickthrough URL
- **Max file size**: 200KB

#### display_970x250
Billboard banner
- **Dimensions**: 970x250 pixels
- **Assets**: Banner image, clickthrough URL
- **Max file size**: 300KB

#### mobile_interstitial_320x480
Full-screen mobile interstitial
- **Dimensions**: 320x480 pixels
- **Assets**: Interstitial image, clickthrough URL
- **Platform**: Mobile-optimized

### Video Formats

#### video_skippable_15s
15-second skippable video
- **Duration**: 15 seconds
- **Skippable after**: 5 seconds
- **Aspect ratios**: 16:9, 9:16, 1:1
- **Delivery**: Hosted or VAST

#### video_non_skippable_30s
30-second non-skippable video
- **Duration**: 30 seconds
- **Aspect ratio**: 16:9
- **Resolution**: 1920x1080 or 1280x720
- **Max bitrate**: 10 Mbps

#### video_story_vertical
Vertical story format
- **Duration**: 6-15 seconds
- **Aspect ratio**: 9:16
- **Resolution**: 1080x1920
- **Platform**: Mobile-first

#### video_outstream_native
In-content video player
- **Duration**: 15-30 seconds
- **Autoplay**: Muted by default
- **Player size**: Responsive
- **Context**: Within article content

### Native Formats

#### native_responsive
Responsive native ad
- **Components**: Headline, description, image, logo, CTA
- **Image ratio**: 1.91:1 or 1:1
- **Headline**: Max 80 characters
- **Description**: Max 200 characters

### Retail Formats

#### retail_product_carousel
Multi-product carousel
- **Products**: 3-10 items
- **Per product**: Image, name, price, URL
- **Navigation**: Swipe or click
- **Layout**: Horizontal scroll

### Foundational Formats

#### foundational_immersive_canvas
Premium responsive canvas that adapts across devices
- **Hero image**: 1200x627
- **Optional video**: 15-30s
- **Responsive**: Adapts to viewport
- **Rich media**: Interactive elements supported

#### foundational_video_15s
Universal 15-second video
- **Works everywhere**: All publishers support this
- **Multiple aspects**: 16:9, 9:16, 1:1
- **Delivery flexible**: Hosted or VAST

## Implementation Guide

### For Publishers

#### Step 1: Declare Format Support

```json
{
  "supported_formats": [
    {
      "format_id": "display_300x250",
      "placements": ["sidebar", "in-article"],
      "min_cpm": 2.00
    },
    {
      "format_id": "video_skippable_15s",
      "placements": ["pre-roll", "mid-roll"],
      "min_cpm": 10.00
    }
  ]
}
```

#### Step 2: Return in list_creative_formats

```json
{
  "formats": [
    {
      "format_id": "display_300x250",
      "name": "Medium Rectangle",
      "type": "display",
      "category": "standard",
      "dimensions": "300x250",
      "assets_required": [
        {
          "asset_id": "banner_image",
          "asset_type": "image",
          "asset_role": "hero_image",
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

#### Step 3: Accept Standard Assets

When receiving creative assets with standard format IDs, validate against the standard specification rather than custom requirements.

### For Buyers

#### Step 1: Query Available Formats

```json
{
  "tool": "list_creative_formats",
  "parameters": {
    "category": "standard"  // Filter for standard formats
  }
}
```

#### Step 2: Select Formats for Campaign

```json
{
  "tool": "create_media_buy",
  "parameters": {
    "packages": [
      {
        "formats_to_provide": [
          "display_300x250",
          "video_skippable_15s"
        ]
      }
    ]
  }
}
```

#### Step 3: Submit Creative Assets

```json
{
  "tool": "sync_creatives",
  "parameters": {
    "format_id": "display_300x250",
    "assets": [
      {
        "asset_role": "hero_image",
        "asset_type": "image",
        "url": "https://cdn.example.com/banner.jpg",
        "width": 300,
        "height": 250
      },
      {
        "asset_role": "clickthrough_url",
        "asset_type": "url",
        "url": "https://example.com/landing"
      }
    ]
  }
}
```

## Extending Standard Formats

Publishers can extend standard formats while maintaining compatibility:

```json
{
  "format_id": "publisher_premium_300x250",
  "extends": "display_300x250",
  "publisher": "example_publisher",
  "modifications": {
    "placement": {
      "positions": ["above-fold-only"],
      "viewability": "100% in view for 1s"
    },
    "performance": {
      "min_ctr": 0.5,
      "optimization": "auto-refresh-30s"
    }
  }
}
```

### Extension Rules

1. **Must accept base format assets**: Extensions cannot require different core assets
2. **Can add optional enhancements**: Additional assets or features are allowed
3. **Maintain compatibility**: Base format creatives must work without modification
4. **Document clearly**: Specify what makes your extension unique

## Migration Path

### From Custom to Standard

1. **Audit existing formats**: Map custom formats to standard equivalents
2. **Identify gaps**: Document any unique requirements
3. **Implement support**: Add standard format handling alongside custom
4. **Test thoroughly**: Verify standard creatives render correctly
5. **Communicate changes**: Update documentation and notify partners
6. **Monitor performance**: Track adoption and performance metrics

### Compatibility Matrix

| Custom Format | Standard Equivalent | Migration Effort |
|--------------|-------------------|-----------------|
| Banner 300x250 | display_300x250 | Low |
| Video Pre-roll | video_skippable_15s | Low |
| Native In-feed | native_responsive | Medium |
| Product Gallery | retail_product_carousel | Medium |
| Custom Canvas | foundational_immersive_canvas | High |

## Best Practices

### For Publishers

1. **Start with common formats**: Support widely-used formats first
2. **Be transparent**: Clearly document any extensions or modifications
3. **Maintain compatibility**: Always accept base format specifications
4. **Focus on differentiation**: Compete on placement and performance, not specs

### For Buyers

1. **Use standard formats when possible**: Maximize reach with minimal variants
2. **Provide all required assets**: Include every asset specified in the format
3. **Use asset_role consistently**: Properly identify each asset's purpose
4. **Test across publishers**: Verify creatives work as expected

### For Platforms

1. **Validate strictly**: Ensure formats meet specifications exactly
2. **Cache format definitions**: Store standard format schemas locally
3. **Version carefully**: Track format version changes
4. **Provide clear errors**: Help users understand validation failures

## Examples

### Example 1: Display Campaign

Creating a display campaign with standard banner:

```json
// Step 1: Get products
{
  "tool": "get_products",
  "parameters": {
    "supported_formats": ["display_300x250"]
  }
}

// Step 2: Create media buy
{
  "tool": "create_media_buy",
  "parameters": {
    "packages": [
      {
        "product_id": "sidebar_placement",
        "formats_to_provide": ["display_300x250"],
        "budget": 5000
      }
    ]
  }
}

// Step 3: Add creative
{
  "tool": "sync_creatives",
  "parameters": {
    "media_buy_id": "mb_123",
    "format_id": "display_300x250",
    "assets": [
      {
        "asset_role": "hero_image",
        "url": "https://cdn.example.com/banner.jpg"
      }
    ]
  }
}
```

### Example 2: Video Campaign

Multi-format video campaign:

```json
{
  "formats_to_provide": [
    "video_skippable_15s",     // Desktop/CTV
    "video_story_vertical",     // Mobile
    "video_outstream_native"    // In-article
  ],
  "creative_strategy": "format_optimization",
  "delivery_preferences": {
    "desktop": "video_skippable_15s",
    "mobile": "video_story_vertical",
    "tablet": "video_skippable_15s"
  }
}
```

### Example 3: Retail Campaign

Product carousel with dynamic content:

```json
{
  "format_id": "retail_product_carousel",
  "products": [
    {
      "product_id": "sku_001",
      "image_url": "https://cdn.example.com/product1.jpg",
      "name": "Premium Headphones",
      "price": "$199.99",
      "sale_price": "$149.99",
      "url": "https://shop.example.com/product1"
    },
    // ... more products
  ],
  "global_assets": {
    "brand_logo": "https://cdn.example.com/logo.png",
    "cta_text": "Shop Now"
  }
}
```

## Troubleshooting

### Common Issues

1. **Asset validation fails**
   - Verify asset dimensions match exactly
   - Check file size limits
   - Ensure HTTPS URLs

2. **Format not accepted**
   - Confirm publisher supports the format
   - Check format_id spelling
   - Verify all required assets provided

3. **Creative not rendering**
   - Validate against schema
   - Check asset_role assignments
   - Verify URL accessibility

### Validation Tools

Use the schema validator to check format compliance:

```bash
# Validate format definition
curl -X POST https://api.adcp.org/validate \
  -d @my-format.json

# Check creative assets
curl -X POST https://api.adcp.org/validate-creative \
  -d @my-creative.json
```

## Resources

- [Format Schemas](https://github.com/adcontextprotocol/adcp/tree/main/static/schemas/v1/standard-formats)
- [Creative Formats Reference](./creative-formats.md)
- [Asset Types Documentation](./asset-types.md)
- [Task Reference](./tasks/get_products.md)

## Next Steps

1. Review available [standard formats](#available-standard-formats)
2. Implement support for relevant formats
3. Test with example creatives
4. Monitor performance and iterate

For questions or to propose new standard formats, please open an issue in the [AdCP GitHub repository](https://github.com/adcontextprotocol/adcp).