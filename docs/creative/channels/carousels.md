---
title: Carousel & Multi-Asset Formats
---

# Carousel & Multi-Asset Formats

This guide covers how AdCP represents carousel and multi-asset advertising formats that display multiple items in sequence: product carousels, image slideshows, story sequences, and video playlists.

## Carousel Format Characteristics

Carousel formats use repeatable asset groups to represent:
- **Product Carousels** - Multiple products with images, titles, and prices
- **Image Slideshows** - Series of images with optional captions
- **Story Sequences** - Sequential narrative frames (mobile stories)
- **Video Playlists** - Multiple video clips displayed in sequence

All carousel formats use `asset_group_id` with `repeatable: true`, `min_count`, and `max_count` to define the structure.

## Repeatable Asset Groups

### Basic Structure

Carousel formats define a repeatable asset group containing the assets for each item:

```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "product_carousel_3_to_10"
  },
  "type": "display",
  "dimensions": "300x250",
  "assets_required": [
    {
      "asset_group_id": "product",
      "repeatable": true,
      "min_count": 3,
      "max_count": 10,
      "assets": [
        {
          "asset_id": "image",
          "asset_type": "image",
          "asset_role": "product_image",
          "requirements": {
            "width": 300,
            "height": 300,
            "aspect_ratio": "1:1"
          }
        },
        {
          "asset_id": "title",
          "asset_type": "text",
          "requirements": {"max_length": 50}
        },
        {
          "asset_id": "price",
          "asset_type": "text",
          "requirements": {"max_length": 20}
        }
      ]
    },
    {
      "asset_id": "brand_logo",
      "asset_type": "image",
      "requirements": {"width": 80, "height": 80}
    }
  ]
}
```

## Standard Carousel Formats

### Product Carousel (Display)

```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "product_carousel_display"
  },
  "type": "display",
  "dimensions": "300x600",
  "assets_required": [
    {
      "asset_group_id": "product",
      "repeatable": true,
      "min_count": 2,
      "max_count": 5,
      "assets": [
        {
          "asset_id": "image",
          "asset_type": "image",
          "asset_role": "product_image",
          "requirements": {"width": 300, "height": 250}
        },
        {
          "asset_id": "title",
          "asset_type": "text",
          "requirements": {"max_length": 40}
        },
        {
          "asset_id": "description",
          "asset_type": "text",
          "requirements": {"max_length": 100}
        },
        {
          "asset_id": "cta_text",
          "asset_type": "text",
          "requirements": {"max_length": 15}
        }
      ]
    }
  ]
}
```

### Image Slideshow

```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "image_slideshow_5s_each"
  },
  "type": "display",
  "dimensions": "728x90",
  "assets_required": [
    {
      "asset_group_id": "slide",
      "repeatable": true,
      "min_count": 3,
      "max_count": 8,
      "assets": [
        {
          "asset_id": "image",
          "asset_type": "image",
          "requirements": {"width": 728, "height": 90}
        },
        {
          "asset_id": "caption",
          "asset_type": "text",
          "required": false,
          "requirements": {"max_length": 60}
        }
      ]
    }
  ]
}
```

### Story Sequence (Mobile)

```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "mobile_story_vertical"
  },
  "type": "display",
  "dimensions": "1080x1920",
  "assets_required": [
    {
      "asset_group_id": "frame",
      "repeatable": true,
      "min_count": 3,
      "max_count": 7,
      "assets": [
        {
          "asset_id": "background",
          "asset_type": "image",
          "asset_role": "background_image",
          "requirements": {
            "width": 1080,
            "height": 1920,
            "aspect_ratio": "9:16"
          }
        },
        {
          "asset_id": "headline",
          "asset_type": "text",
          "requirements": {"max_length": 30}
        },
        {
          "asset_id": "body",
          "asset_type": "text",
          "requirements": {"max_length": 100}
        }
      ]
    },
    {
      "asset_id": "brand_logo",
      "asset_type": "image",
      "requirements": {"width": 100, "height": 100}
    }
  ]
}
```

### Video Playlist

```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "video_playlist_6s_bumpers"
  },
  "type": "video",
  "assets_required": [
    {
      "asset_group_id": "clip",
      "repeatable": true,
      "min_count": 2,
      "max_count": 5,
      "assets": [
        {
          "asset_id": "video",
          "asset_type": "video",
          "requirements": {
            "duration": "6s",
            "format": "MP4 H.264",
            "resolution": ["1920x1080"]
          }
        }
      ]
    }
  ]
}
```

## Creative Manifests

### Naming Convention

Assets in manifests use the pattern: `{group_id}_{index}_{asset_id}`

Indexing is **zero-based**: `product_0_image`, `product_1_image`, `product_2_image`

**Example**: For a format with `asset_group_id: "product"` and `asset_id: "image"`, the manifest provides:
- First item: `product_0_image`
- Second item: `product_1_image`
- Third item: `product_2_image`

All assets for a given index must be provided together (you cannot have `product_0_image` without `product_0_title` if title is required).

### Product Carousel Manifest

```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "product_carousel_3_to_10"
  },
  "assets": {
    "product_0_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/products/shoes_red.jpg",
      "width": 300,
      "height": 300
    },
    "product_0_title": {
      "asset_type": "text",
      "content": "Red Running Shoes"
    },
    "product_0_price": {
      "asset_type": "text",
      "content": "$89.99"
    },
    "product_1_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/products/shoes_blue.jpg",
      "width": 300,
      "height": 300
    },
    "product_1_title": {
      "asset_type": "text",
      "content": "Blue Trail Shoes"
    },
    "product_1_price": {
      "asset_type": "text",
      "content": "$79.99"
    },
    "product_2_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/products/shoes_black.jpg",
      "width": 300,
      "height": 300
    },
    "product_2_title": {
      "asset_type": "text",
      "content": "Black Casual Shoes"
    },
    "product_2_price": {
      "asset_type": "text",
      "content": "$69.99"
    },
    "brand_logo": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/logo.png",
      "width": 80,
      "height": 80
    },
    "landing_url": {
      "asset_type": "url",
      "url_type": "clickthrough",
      "url": "https://brand.com/shoes?campaign={MEDIA_BUY_ID}"
    }
  }
}
```

### Story Sequence Manifest

```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "mobile_story_vertical"
  },
  "assets": {
    "frame_0_background": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/story_frame1.jpg",
      "width": 1080,
      "height": 1920
    },
    "frame_0_headline": {
      "asset_type": "text",
      "content": "New Collection"
    },
    "frame_0_body": {
      "asset_type": "text",
      "content": "Discover our latest summer styles"
    },
    "frame_1_background": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/story_frame2.jpg",
      "width": 1080,
      "height": 1920
    },
    "frame_1_headline": {
      "asset_type": "text",
      "content": "50% Off"
    },
    "frame_1_body": {
      "asset_type": "text",
      "content": "Limited time offer on all items"
    },
    "frame_2_background": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/story_frame3.jpg",
      "width": 1080,
      "height": 1920
    },
    "frame_2_headline": {
      "asset_type": "text",
      "content": "Shop Now"
    },
    "frame_2_body": {
      "asset_type": "text",
      "content": "Tap to explore the collection"
    },
    "brand_logo": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/logo.png",
      "width": 100,
      "height": 100
    },
    "landing_url": {
      "asset_type": "url",
      "url_type": "clickthrough",
      "url": "https://brand.com/summer-sale?device={DEVICE_ID}&campaign={MEDIA_BUY_ID}"
    }
  }
}
```

## Manifest Validation Rules

### Complete Groups Required

Each group instance must include all required assets defined in the format:

```json
// ❌ INVALID - missing product_1_title
{
  "product_0_image": {...},
  "product_0_title": {...},
  "product_1_image": {...}
}

// ✅ VALID - all required assets present for each product
{
  "product_0_image": {...},
  "product_0_title": {...},
  "product_1_image": {...},
  "product_1_title": {...}
}
```

### Count Constraints

Manifests must provide between `min_count` and `max_count` instances:

```json
// Format specification
{
  "asset_group_id": "product",
  "min_count": 3,
  "max_count": 10
}

// ❌ INVALID - only 2 products (below minimum)
{
  "product_0_image": {...},
  "product_1_image": {...}
}

// ✅ VALID - 3 products (meets minimum)
{
  "product_0_image": {...},
  "product_1_image": {...},
  "product_2_image": {...}
}
```

### Optional Assets

Individual assets within a group can be marked `"required": false`:

```json
{
  "asset_group_id": "slide",
  "assets": [
    {
      "asset_id": "image",
      "required": true
    },
    {
      "asset_id": "caption",
      "required": false  // Can be omitted
    }
  ]
}
```

Optional assets can be provided for some instances but not others:

```json
{
  "slide_0_image": {...},
  "slide_0_caption": {...},  // Caption provided
  "slide_1_image": {...},    // No caption
  "slide_2_image": {...},
  "slide_2_caption": {...}   // Caption provided
}
```

### Zero-Based Indexing

Always use sequential zero-based indexing starting from 0:

```
product_0_image
product_0_title
product_1_image
product_1_title
product_2_image
product_2_title
```

## Clickthrough URL Patterns

### Single Landing URL

All carousel items link to the same destination:

```json
{
  "landing_url": {
    "asset_type": "url",
    "url_type": "clickthrough",
    "url": "https://brand.com/products?campaign={MEDIA_BUY_ID}"
  }
}
```

### Per-Item Landing URLs

Each carousel item can have its own clickthrough URL (if supported by format):

```json
{
  "product_0_landing_url": {
    "asset_type": "url",
    "url_type": "clickthrough",
    "url": "https://brand.com/product/shoes-red?campaign={MEDIA_BUY_ID}"
  },
  "product_1_landing_url": {
    "asset_type": "url",
    "url_type": "clickthrough",
    "url": "https://brand.com/product/shoes-blue?campaign={MEDIA_BUY_ID}"
  },
  "product_2_landing_url": {
    "asset_type": "url",
    "url_type": "clickthrough",
    "url": "https://brand.com/product/shoes-black?campaign={MEDIA_BUY_ID}"
  }
}
```

The format definition specifies whether per-item URLs are supported.

## Carousel-Specific Macros

In addition to [universal macros](../universal-macros.md), some platforms support carousel-specific macros:

- `{CAROUSEL_INDEX}` - Zero-based index of current carousel item
- `{CAROUSEL_POSITION}` - One-based position (for user display)
- `{CAROUSEL_TOTAL}` - Total number of items in carousel

**Example tracking URL:**
```
https://track.brand.com/view?buy={MEDIA_BUY_ID}&item={CAROUSEL_INDEX}&total={CAROUSEL_TOTAL}
```

## Complete Example

### Format Definition

```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "ecommerce_carousel_300x600"
  },
  "name": "E-commerce Product Carousel",
  "type": "display",
  "dimensions": "300x600",
  "assets_required": [
    {
      "asset_group_id": "product",
      "repeatable": true,
      "min_count": 3,
      "max_count": 6,
      "assets": [
        {
          "asset_id": "image",
          "asset_type": "image",
          "asset_role": "product_image",
          "requirements": {
            "width": 300,
            "height": 300,
            "aspect_ratio": "1:1",
            "file_types": ["jpg", "png", "webp"]
          }
        },
        {
          "asset_id": "title",
          "asset_type": "text",
          "requirements": {"max_length": 50}
        },
        {
          "asset_id": "price",
          "asset_type": "text",
          "requirements": {"max_length": 20}
        },
        {
          "asset_id": "discount_badge",
          "asset_type": "text",
          "required": false,
          "requirements": {"max_length": 10}
        }
      ]
    },
    {
      "asset_id": "brand_logo",
      "asset_type": "image",
      "requirements": {"width": 80, "height": 80}
    },
    {
      "asset_id": "cta_text",
      "asset_type": "text",
      "requirements": {"max_length": 15}
    }
  ]
}
```

### Manifest

```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "ecommerce_carousel_300x600"
  },
  "assets": {
    "product_0_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/products/watch_gold.jpg",
      "width": 300,
      "height": 300
    },
    "product_0_title": {
      "asset_type": "text",
      "content": "Gold Classic Watch"
    },
    "product_0_price": {
      "asset_type": "text",
      "content": "$299"
    },
    "product_0_discount_badge": {
      "asset_type": "text",
      "content": "25% OFF"
    },
    "product_1_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/products/watch_silver.jpg",
      "width": 300,
      "height": 300
    },
    "product_1_title": {
      "asset_type": "text",
      "content": "Silver Sport Watch"
    },
    "product_1_price": {
      "asset_type": "text",
      "content": "$249"
    },
    "product_2_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/products/watch_leather.jpg",
      "width": 300,
      "height": 300
    },
    "product_2_title": {
      "asset_type": "text",
      "content": "Leather Dress Watch"
    },
    "product_2_price": {
      "asset_type": "text",
      "content": "$199"
    },
    "product_2_discount_badge": {
      "asset_type": "text",
      "content": "NEW"
    },
    "brand_logo": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/logo.png",
      "width": 80,
      "height": 80
    },
    "cta_text": {
      "asset_type": "text",
      "content": "Shop Now"
    },
    "landing_url": {
      "asset_type": "url",
      "url_type": "clickthrough",
      "url": "https://brand.com/watches?campaign={MEDIA_BUY_ID}&utm_source={DOMAIN}"
    },
    "impression_tracker": {
      "asset_type": "url",
      "url_type": "tracker",
      "url": "https://track.brand.com/imp?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    }
  }
}
```

## Related Documentation

- [Creative Manifests](../creative-manifests.md) - Complete manifest specification
- [Universal Macros](../universal-macros.md) - Supported macros for tracking
- [Asset Types](../asset-types.md) - Asset type specifications
- [Display Ads](display.md) - Standard display formats
- [Video Ads](video.md) - Video format specifications
