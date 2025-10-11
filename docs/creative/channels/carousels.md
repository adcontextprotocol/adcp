---
title: Carousel & Multi-Asset Formats
---

# Carousel & Multi-Asset Formats

This guide covers formats that display multiple items in sequence: product carousels, image slideshows, story formats, and video playlists.

## Overview

Carousel formats use **repeatable asset groups** - the same pattern works for:

- **Product Carousels** - Multiple products with images, titles, prices
- **Image Slideshows** - Series of photos with captions
- **Story Formats** - Sequential narrative frames
- **Video Playlists** - Multiple video clips in sequence

All use the same `asset_group_id` pattern with `min_count` and `max_count`.

## Repeatable Asset Groups

### Format Structure

```json
{
  "format_id": "product_carousel_3_to_10",
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

### Manifest Pattern

Assets use naming pattern: `{group_id}_{index}_{asset_id}`

```json
{
  "format_id": "product_carousel_3_to_10",
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
      "url_purpose": "clickthrough",
      "url": "https://brand.com/shoes?product={PRODUCT_ID}&campaign={MEDIA_BUY_ID}"
    }
  }
}
```

## Common Carousel Formats

### Product Carousel (Display)

```json
{
  "format_id": "product_carousel_display",
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
  "format_id": "image_slideshow_5s_each",
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

### Story Format (Mobile)

Mobile-first sequential story format:

```json
{
  "format_id": "mobile_story_vertical",
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

Multiple video clips in sequence:

```json
{
  "format_id": "video_playlist_6s_bumpers",
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

## Creating Carousel Manifests

### Basic Product Carousel

```json
{
  "format_id": "product_carousel_3_to_10",
  "assets": {
    "product_0_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/product1.jpg",
      "width": 300,
      "height": 300
    },
    "product_0_title": {
      "asset_type": "text",
      "content": "Summer Dress"
    },
    "product_0_price": {
      "asset_type": "text",
      "content": "$49.99"
    },
    "product_1_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/product2.jpg",
      "width": 300,
      "height": 300
    },
    "product_1_title": {
      "asset_type": "text",
      "content": "Casual Jeans"
    },
    "product_1_price": {
      "asset_type": "text",
      "content": "$39.99"
    },
    "product_2_image": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/product3.jpg",
      "width": 300,
      "height": 300
    },
    "product_2_title": {
      "asset_type": "text",
      "content": "Canvas Sneakers"
    },
    "product_2_price": {
      "asset_type": "text",
      "content": "$29.99"
    },
    "brand_logo": {
      "asset_type": "image",
      "url": "https://cdn.brand.com/logo.png",
      "width": 80,
      "height": 80
    },
    "landing_url": {
      "asset_type": "url",
      "url_purpose": "clickthrough",
      "url": "https://brand.com/summer?campaign={MEDIA_BUY_ID}"
    }
  }
}
```

### Story Format with Macros

```json
{
  "format_id": "mobile_story_vertical",
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
      "url_purpose": "clickthrough",
      "url": "https://brand.com/summer-sale?device={DEVICE_ID}&campaign={MEDIA_BUY_ID}"
    },
    "impression_tracker": {
      "asset_type": "url",
      "url_purpose": "impression_tracker",
      "url": "https://track.brand.com/imp?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    }
  }
}
```

## Carousel-Specific Considerations

### Indexing Pattern

Always use zero-based indexing: `{group_id}_0_{asset_id}`, `{group_id}_1_{asset_id}`, etc.

```
product_0_image
product_0_title
product_1_image
product_1_title
```

### Partial Groups Not Allowed

Each group instance must include **all required assets** in that group:

```json
// ❌ INVALID - missing product_1_title
{
  "product_0_image": {...},
  "product_0_title": {...},
  "product_1_image": {...}
}

// ✅ VALID - all assets present for each product
{
  "product_0_image": {...},
  "product_0_title": {...},
  "product_1_image": {...},
  "product_1_title": {...}
}
```

### Count Validation

Manifests must respect `min_count` and `max_count`:

```json
// Format requires 3-10 products
{
  "asset_group_id": "product",
  "min_count": 3,
  "max_count": 10
}

// ❌ INVALID - only 2 products
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

### Optional Assets in Groups

Individual assets within a group can be optional:

```json
{
  "asset_group_id": "slide",
  "repeatable": true,
  "min_count": 3,
  "max_count": 8,
  "assets": [
    {
      "asset_id": "image",
      "asset_type": "image",
      "required": true
    },
    {
      "asset_id": "caption",
      "asset_type": "text",
      "required": false  // Optional
    }
  ]
}
```

You can provide captions for some slides but not others:

```json
{
  "slide_0_image": {...},
  "slide_0_caption": {...},  // Included
  "slide_1_image": {...},    // No caption for this slide
  "slide_2_image": {...},
  "slide_2_caption": {...}   // Caption included again
}
```

## Best Practices

### Asset Consistency

Keep assets within a carousel consistent:
- **Same dimensions** for all images in the group
- **Similar content length** for text fields
- **Consistent quality** across all items
- **Visual coherence** (same style, colors, branding)

### Performance

- **Lazy loading**: Load carousel items as needed, not all upfront
- **Image optimization**: Use appropriate file sizes for carousel images
- **Total size limit**: Keep total manifest size reasonable (typically under 2MB)

### User Experience

- **Clear navigation**: Show indicators (dots, arrows) for multi-item carousels
- **Auto-advance timing**: 3-5 seconds per slide for auto-rotating carousels
- **Swipe support**: Enable touch gestures on mobile
- **Pause on interaction**: Stop auto-rotation when user engages

### Clickthrough Behavior

Different approaches for carousel clicks:

#### Single Landing URL
All items link to same destination:
```json
{
  "landing_url": {
    "asset_type": "url",
    "url_purpose": "clickthrough",
    "url": "https://brand.com/products?campaign={MEDIA_BUY_ID}"
  }
}
```

#### Per-Item Landing URLs
Each carousel item has its own link:
```json
{
  "product_0_landing_url": {
    "asset_type": "url",
    "url_purpose": "clickthrough",
    "url": "https://brand.com/product/shoes-red?campaign={MEDIA_BUY_ID}"
  },
  "product_1_landing_url": {
    "asset_type": "url",
    "url_purpose": "clickthrough",
    "url": "https://brand.com/product/shoes-blue?campaign={MEDIA_BUY_ID}"
  }
}
```

Format should specify if per-item URLs are supported.

### Tracking Individual Items

Track which carousel items are viewed/clicked using macros:

```json
{
  "impression_tracker": {
    "asset_type": "url",
    "url_purpose": "impression_tracker",
    "url": "https://track.brand.com/view?buy={MEDIA_BUY_ID}&item={CAROUSEL_INDEX}&cb={CACHEBUSTER}"
  }
}
```

Some platforms support `{CAROUSEL_INDEX}` macro for item-level tracking.

## Discovery

### Finding Carousel Formats

Use `list_creative_formats` to discover carousel formats:

```json
{
  "asset_types": ["image", "text"],
  "name_search": "carousel"
}
```

Or search by specific dimensions:

```json
{
  "asset_types": ["image", "text"],
  "dimensions": "300x250",
  "name_search": "product"
}
```

### Identifying Repeatable Groups

Look for `repeatable: true` in format definitions:

```json
{
  "format_id": "product_carousel",
  "assets_required": [
    {
      "asset_group_id": "product",
      "repeatable": true,  // ← Indicates carousel/sequence format
      "min_count": 3,
      "max_count": 10
    }
  ]
}
```

## Example: Complete Product Carousel

Format definition:
```json
{
  "format_id": "ecommerce_carousel_300x600",
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

Manifest:
```json
{
  "format_id": "ecommerce_carousel_300x600",
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
      "url_purpose": "clickthrough",
      "url": "https://brand.com/watches?campaign={MEDIA_BUY_ID}&utm_source={DOMAIN}"
    },
    "impression_tracker": {
      "asset_type": "url",
      "url_purpose": "impression_tracker",
      "url": "https://track.brand.com/imp?buy={MEDIA_BUY_ID}&cb={CACHEBUSTER}"
    }
  }
}
```

## Related Documentation

- [Creative Protocol](../index.md) - How assets, formats, and manifests work together
- [Creative Manifests](../creative-manifests.md) - Repeatable asset group specifications
- [Universal Macros](../universal-macros.md) - Supported macros for tracking and personalization
- [Display Ads](display.md) - Standard display format patterns
- [Video Ads](video.md) - Video playlist formats
