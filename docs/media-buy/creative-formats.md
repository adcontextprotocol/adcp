---
title: Creative Formats
---

# Creative Formats

All creative formats have a unique identifier and specify delivery methods. Formats can require either a single asset or multiple assets for rich media experiences.

## Authoritative Source

The official JSON schema for standard creative formats is available at:
- **Production**: https://adcontextprotocol.org/schemas/creative-formats-v1.json
- **GitHub**: https://github.com/adcontextprotocol/adcp/blob/main/static/schemas/creative-formats-v1.json

### Programmatic Access

Servers should fetch and cache this schema:

```bash
# Fetch the latest creative formats
curl https://adcontextprotocol.org/schemas/creative-formats-v1.json

# Or use the GitHub raw URL
curl https://raw.githubusercontent.com/adcontextprotocol/adcp/main/static/schemas/creative-formats-v1.json
```

### Schema Structure

The JSON schema includes:
- **formats**: Organized by type (video, audio, display, rich_media, dooh)
- **specs**: Technical specifications for each format
- **delivery_options**: Supported delivery methods and protocols
- **delivery_protocols**: Reference information for VAST, MRAID, etc.
- **assets_required**: For multi-asset formats like carousels and sliders

### Version Management

- Current version: v1
- Updates will be versioned (creative-formats-v2.json, etc.)
- Breaking changes will increment the major version
- Implementations should check the `version` field

#### Standard Video Formats

##### video_standard_1080p
```json
{
  "format_id": "video_standard_1080p",
  "name": "Standard HD Video",
  "type": "video",
  "description": "Standard 1080p video ad",
  "specs": {
    "resolution": "1920x1080",
    "duration": "15s or 30s",
    "file_format": "MP4",
    "max_file_size": "50MB"
  },
  "delivery_options": {
    "hosted": {
      "supported": true,
      "description": "Direct URL to video file"
    },
    "vast": {
      "supported": true,
      "versions": ["3.0", "4.0", "4.1", "4.2"],
      "features": ["linear", "skippable", "companions"]
    },
    "vpaid": {
      "supported": false,
      "reason": "Security and performance concerns"
    }
  }
}
```

##### video_vertical_mobile
```json
{
  "format_id": "video_vertical_mobile",
  "name": "Vertical Mobile Video",
  "type": "video",
  "description": "Full-screen vertical video for mobile",
  "specs": {
    "resolution": "1080x1920 (9:16)",
    "duration": "6s, 15s, or 30s",
    "file_format": "MP4",
    "features": ["skippable after 5s", "sound off by default"]
  },
  "delivery_options": {
    "hosted": {
      "supported": true
    },
    "vast": {
      "supported": true,
      "versions": ["4.0+"],
      "required_extensions": ["OMID for viewability"]
    }
  }
}
```

#### Standard Audio Formats

##### audio_streaming
```json
{
  "format_id": "audio_streaming",
  "name": "Streaming Audio Ad",
  "type": "audio",
  "description": "Audio ad for music/podcast streaming",
  "specs": {
    "duration": "15s, 30s, or 60s",
    "file_format": "MP3 or M4A",
    "bitrate": "128kbps minimum",
    "companion_banner": "640x640 optional"
  },
  "delivery_options": {
    "hosted": {
      "supported": true,
      "description": "Direct URL to audio file"
    },
    "vast": {
      "supported": true,
      "versions": ["4.1+"],
      "notes": "Audio delivered via VAST MediaFile"
    },
    "daast": {
      "supported": false,
      "reason": "Deprecated in favor of VAST 4.1"
    }
  }
}
```

#### Standard Display Formats

##### display_banner
```json
{
  "format_id": "display_banner",
  "name": "Standard Banner",
  "type": "display",
  "description": "Traditional banner ad",
  "specs": {
    "sizes": ["300x250", "728x90", "320x50"],
    "max_file_size": "200KB initial load",
    "animation": "15s max"
  },
  "delivery_options": {
    "image": {
      "supported": true,
      "formats": ["JPG", "PNG", "GIF"]
    },
    "html5": {
      "supported": true,
      "restrictions": [
        "No document.write()",
        "SSL required for all assets",
        "Must be responsive"
      ]
    },
    "third_party_tag": {
      "supported": true,
      "formats": ["JavaScript tag", "iFrame tag"],
      "restrictions": [
        "Must be SSL",
        "No auto-expand",
        "No auto-audio"
      ]
    }
  }
}
```

#### Multi-Asset Display Formats

##### display_product_carousel
```json
{
  "format_id": "display_product_carousel",
  "name": "Dynamic Product Carousel",
  "type": "display",
  "format_type": "product_carousel",
  "description": "Interactive carousel showcasing multiple products",
  "min_products": 3,
  "max_products": 10,
  "product_schema": {
    "product_image": {
      "required": true,
      "requirements": {
        "width": 300,
        "height": 300,
        "file_types": ["jpg", "png", "webp"],
        "max_file_size": 150000
      }
    },
    "product_name": {
      "required": true,
      "requirements": {
        "type": "text",
        "max_length": 50
      }
    },
    "product_price": {
      "required": true,
      "requirements": {
        "type": "text",
        "max_length": 20,
        "format": "currency"
      }
    },
    "product_url": {
      "required": true,
      "requirements": {
        "type": "url",
        "must_be_https": true
      }
    },
    "product_description": {
      "required": false,
      "requirements": {
        "type": "text",
        "max_length": 150
      }
    },
    "sale_price": {
      "required": false,
      "requirements": {
        "type": "text",
        "max_length": 20,
        "format": "currency"
      }
    }
  },
  "global_assets": {
    "brand_logo": {
      "required": true,
      "requirements": {
        "width": 200,
        "height": 50,
        "file_types": ["png", "svg"]
      }
    },
    "cta_text": {
      "required": true,
      "requirements": {
        "type": "text",
        "max_length": 20,
        "default": "Shop Now"
      }
    }
  },
  "delivery_options": {
    "hosted": {
      "supported": true,
      "description": "Publisher dynamically assembles carousel from product feed"
    }
  }
}
```

##### display_slider_300x600
```json
{
  "format_id": "display_slider_300x600",
  "name": "Half Page Slider - 2 Frames",
  "type": "display",
  "description": "Alternating half-page banner with 2 frames",
  "assets_required": [
    {
      "asset_type": "frame_1",
      "quantity": 1,
      "requirements": {
        "width": 300,
        "height": 600,
        "file_types": ["jpg", "png"],
        "max_file_size": 300000
      }
    },
    {
      "asset_type": "frame_2",
      "quantity": 1,
      "requirements": {
        "width": 300,
        "height": 600,
        "file_types": ["jpg", "png"],
        "max_file_size": 300000
      }
    },
    {
      "asset_type": "clickthrough_url",
      "quantity": 1,
      "requirements": {
        "type": "url",
        "must_be_https": true
      }
    }
  ],
  "animation": {
    "type": "alternating",
    "transition_interval": 5,
    "transition_type": "fade"
  },
  "delivery_options": {
    "hosted": {
      "supported": true,
      "description": "Publisher handles animation between frames"
    }
  }
}
```

#### Custom Publisher Formats

##### retail_media_product_carousel
```json
{
  "format_id": "retail_media_product_carousel",
  "name": "Sponsored Product Carousel",
  "type": "native",
  "publisher": "major_retailer",
  "description": "Native carousel of sponsored products",
  "specs": {
    "products_per_carousel": "4-8",
    "product_data": {
      "title": "max 60 chars",
      "price": "required",
      "image": "500x500 minimum",
      "rating": "optional",
      "prime_badge": "optional"
    }
  },
  "template": {
    "type": "kevel_template",
    "template_id": "carousel_v2",
    "customization": {
      "background_color": "brand hex color",
      "cta_text": ["Shop Now", "Learn More"],
      "layout": ["horizontal", "grid"]
    }
  },
  "data_requirements": {
    "product_feed": "XML or JSON",
    "update_frequency": "hourly",
    "inventory_status": "real-time"
  }
}
```

##### retail_media_search_takeover
```json
{
  "format_id": "retail_media_search_takeover",
  "name": "Search Results Takeover",
  "type": "native",
  "publisher": "major_retailer",
  "description": "Premium placement at top of search results",
  "specs": {
    "hero_banner": {
      "size": "1200x300",
      "file_format": "JPG or HTML5"
    },
    "product_grid": {
      "products": "4-6",
      "layout": "responsive grid"
    }
  },
  "template": {
    "type": "kevel_template",
    "template_id": "search_takeover_v3",
    "merge_fields": {
      "brand_logo": "200x100 PNG",
      "headline": "max 50 chars",
      "products": "array of product IDs"
    }
  },
  "targeting": {
    "trigger": "search keywords",
    "relevance": "products must match search intent"
  }
}
```

## Foundational Publisher Formats

Analysis of custom formats from major publishers reveals that 82% of "custom" formats actually follow five foundational patterns. Publishers can leverage these standardized formats while maintaining their unique value through placement, data, and optimization.

### Why Foundational Formats Matter

- **Efficiency**: Advertisers can reach multiple publishers with minimal creative variations
- **Scale**: One creative package can adapt to 8-10 publisher variations
- **Speed**: Reduce production from weeks to days
- **Innovation**: Focus on performance optimization rather than asset variations

### The Five Foundational Format Categories

#### 1. Immersive Canvas Format

A premium full-width format that scales responsively across devices. Known by various names (Yahoo E2E Lighthouse, NYT Flex Frame, Vox Athena), but shares core specifications.

```json
{
  "format_id": "foundational_immersive_canvas",
  "name": "Immersive Canvas",
  "type": "rich_media",
  "category": "foundational",
  "description": "Premium responsive canvas format",
  "assets_required": [
    {
      "asset_type": "hero_image",
      "requirements": {
        "dimensions": "1200x627",
        "file_types": ["jpg", "png", "webp"],
        "max_file_size": 500000
      }
    },
    {
      "asset_type": "brand_logo",
      "requirements": {
        "dimensions": "250x150",
        "file_types": ["png", "svg"],
        "transparency": true
      }
    },
    {
      "asset_type": "headline",
      "requirements": {
        "type": "text",
        "max_length": 80
      }
    },
    {
      "asset_type": "description",
      "requirements": {
        "type": "text",
        "max_length": 200
      }
    },
    {
      "asset_type": "video",
      "required": false,
      "requirements": {
        "duration": "15-30s",
        "format": "MP4",
        "max_file_size": 50000000
      }
    }
  ],
  "publisher_adaptations": [
    "Yahoo E2E Lighthouse",
    "NYT Flex Frame",
    "Vox Athena",
    "Telegraph Skylight",
    "WSJ Premium Canvas",
    "Hearst Full Width",
    "Condé Nast Parallax",
    "Daily Mail Showcase"
  ]
}
```

#### 2. Product Showcase Carousel

Interactive carousel displaying 3-10 products with swipe/click navigation. Consistent behavior across Yahoo Native Carousel, NYT Product Carousel, Hearst Cube Gallery, and others.

```json
{
  "format_id": "foundational_product_carousel",
  "name": "Product Showcase Carousel",
  "type": "display",
  "category": "foundational",
  "description": "Multi-product interactive carousel",
  "min_products": 3,
  "max_products": 10,
  "product_schema": {
    "product_image": {
      "required": true,
      "requirements": {
        "square": "627x627",
        "rectangle": "1200x627",
        "file_types": ["jpg", "png", "webp"]
      }
    },
    "product_name": {
      "required": true,
      "requirements": {
        "type": "text",
        "max_length": 50
      }
    },
    "product_price": {
      "required": true,
      "requirements": {
        "type": "text",
        "format": "currency"
      }
    },
    "product_url": {
      "required": true,
      "requirements": {
        "type": "url"
      }
    }
  },
  "interaction_patterns": {
    "mobile": "horizontal_swipe",
    "desktop": "click_navigation",
    "tracking": "per_product"
  },
  "publisher_adaptations": [
    "Yahoo Native Carousel",
    "NYT Product Carousel",
    "Hearst Cube Gallery",
    "Teads Carousel",
    "ESPN Shop Carousel",
    "Vox Commerce Cards",
    "Raptive Product Slider"
  ]
}
```

#### 3. Expandable Display Unit

Banner that expands to larger canvas on interaction. Consistent behavior with publisher-specific trigger variations.

```json
{
  "format_id": "foundational_expandable",
  "name": "Expandable Display",
  "type": "rich_media",
  "category": "foundational",
  "description": "Banner with expandable canvas",
  "states": {
    "collapsed": {
      "common_sizes": ["728x90", "970x250", "320x50"],
      "trigger": "publisher_defined"
    },
    "expanded": {
      "height_range": "250-600px",
      "width": "full_width",
      "auto_collapse": "15s"
    }
  },
  "assets_required": [
    {
      "asset_type": "collapsed_creative",
      "requirements": {
        "format": "HTML5",
        "max_initial_load": 200000
      }
    },
    {
      "asset_type": "expanded_creative",
      "requirements": {
        "format": "HTML5",
        "max_file_size": 500000
      }
    }
  ],
  "publisher_adaptations": [
    "Axel Springer Pushdown",
    "WSJ Billboard Expandable",
    "Telegraph Full Width Expandable",
    "Yahoo Rising Star",
    "ESPN Sidekick",
    "Daily Mail Reveal",
    "Vox Breakout",
    "Hearst Unfold",
    "Condé Nast Expand",
    "Raptive Flex"
  ]
}
```

#### 4. Scroll-Triggered Experience

Content that reveals or animates based on scroll position. Consistent mobile-first specifications.

```json
{
  "format_id": "foundational_scroll_reveal",
  "name": "Scroll-Triggered Experience",
  "type": "rich_media",
  "category": "foundational",
  "description": "Scroll-based reveal format",
  "trigger": "scroll_position",
  "specs": {
    "mobile": {
      "standard": "320x480",
      "retina": "640x960"
    },
    "desktop": {
      "width": "full_width",
      "height": "viewport_responsive"
    }
  },
  "assets_required": [
    {
      "asset_type": "scroll_creative",
      "requirements": {
        "format": "HTML5",
        "animation": "CSS or lightweight JS"
      }
    },
    {
      "asset_type": "vertical_video",
      "required": false,
      "requirements": {
        "aspect_ratio": "9:16",
        "duration": "6-15s"
      }
    }
  ],
  "publisher_adaptations": [
    "Axel Springer Interscroller",
    "Telegraph Scroll Reveal",
    "ESPN Parallax",
    "Raptive Scroll Story",
    "Teads inRead",
    "Vox Scroll Experience"
  ]
}
```

#### 5. Universal Video Format

Standardized video specifications that work across all publishers with three core aspect ratios.

```json
{
  "format_id": "foundational_video",
  "name": "Universal Video",
  "type": "video",
  "category": "foundational",
  "description": "Cross-publisher video standard",
  "specs": {
    "duration": "15s or 30s",
    "format": "MP4 H.264",
    "aspect_ratios": {
      "landscape": "16:9",
      "vertical": "9:16",
      "square": "1:1"
    },
    "compliance": {
      "vast": ["2.0", "3.0", "4.0+"],
      "vpaid": false
    },
    "behavior": {
      "autoplay": "muted",
      "user_initiated_sound": true
    }
  },
  "companion_assets": {
    "display_companion": {
      "sizes": ["300x250", "728x90"],
      "required": false
    }
  },
  "publisher_adaptations": [
    "All publishers accept these specifications"
  ]
}
```

### Publisher Support Declaration

Publishers can indicate support for foundational formats in their capabilities:

```json
{
  "publisher": "example_publisher",
  "foundational_format_support": [
    {
      "format_id": "foundational_immersive_canvas",
      "publisher_name": "Premium Showcase",
      "customizations": {
        "placement": "above_fold",
        "interaction_trigger": "hover",
        "data_enrichment": ["contextual", "audience"]
      }
    },
    {
      "format_id": "foundational_product_carousel",
      "publisher_name": "Shop Gallery",
      "customizations": {
        "max_products": 8,
        "layout": "grid_on_desktop"
      }
    }
  ]
}
```

### Implementation Benefits

#### For Advertisers
- **70-80% reduction** in creative variations
- **Single creative kit** works across 8-13 publishers
- **Faster campaign launch** with pre-tested formats
- **Focus budget** on optimization vs. production

#### For Publishers
- **Reduced friction** in campaign onboarding
- **Faster time-to-revenue** with standard assets
- **Differentiation through context** not specifications
- **Higher fill rates** from easier advertiser adoption

### Migration Path

1. **Audit** current custom formats against foundational categories
2. **Map** existing formats to foundational equivalents
3. **Document** any essential customizations
4. **Implement** foundational format support alongside custom
5. **Measure** performance and adoption rates
6. **Optimize** based on results

## Format Extension Mechanism

Publishers should extend standard formats rather than creating custom ones, except for truly unique inventory that doesn't fit any standard pattern.

### When to Extend vs. Create New

#### Always Extend When:
- Your format is a variation of display, video, audio, or rich media
- The core creative assets match a standard format
- Only placement, timing, or interaction details differ
- You want to accept standard creative assets

#### Only Create Custom When:
- The format requires fundamentally different assets
- No standard format can reasonably be adapted
- The format is truly unique to your platform (e.g., AR experiences, voice interfaces)

### Extension Pattern

Publishers extend formats by declaring the base format and their modifications:

```json
{
  "format_id": "publisher_premium_canvas",
  "extends": "foundational_immersive_canvas",
  "publisher": "example_publisher",
  "name": "Premium Story Canvas",
  "modifications": {
    "placement": {
      "positions": ["hero", "mid_article"],
      "viewability": "50% for 1s triggers expansion"
    },
    "interactions": {
      "expansion_trigger": "hover_desktop_scroll_mobile",
      "video_behavior": "autoplay_on_expand",
      "cta_positions": ["bottom_right", "end_frame"]
    },
    "performance": {
      "lazy_load": true,
      "preload_assets": ["hero_image", "logo"]
    },
    "additional_assets": {
      "secondary_cta": {
        "required": false,
        "max_length": 15
      }
    }
  }
}
```

### Benefits of Extension

1. **Advertiser Efficiency**: One creative works across all publishers supporting the base format
2. **Clear Compatibility**: Buyers instantly know which creatives will work
3. **Innovation Focus**: Publishers compete on performance, not specifications
4. **Faster Adoption**: Pre-tested formats reduce integration time

### Standard Extension Points

Publishers can modify these aspects without breaking compatibility:

#### Timing & Triggers
```json
{
  "timing": {
    "autoplay_delay": "3s",
    "expansion_trigger": "user_interaction",
    "collapse_behavior": "auto_15s"
  }
}
```

#### Data Enhancement
```json
{
  "data_enhancement": {
    "contextual_targeting": true,
    "dynamic_creative": ["weather", "location", "time"],
    "personalization": ["interests", "behavior"]
  }
}
```

#### Measurement & Optimization
```json
{
  "measurement": {
    "custom_metrics": ["scroll_depth", "interaction_rate"],
    "attribution_window": "7_days",
    "viewability_standard": "publisher_custom"
  }
}
```

### Declaring Extensions in Capabilities

Publishers should declare both their base format support and extensions:

```json
{
  "supported_formats": [
    {
      "format_id": "foundational_immersive_canvas",
      "supported": true,
      "publisher_variants": [
        {
          "variant_id": "premium_story_canvas",
          "extends": "foundational_immersive_canvas",
          "modifications": {
            "placement": ["hero", "mid_article"],
            "min_spend": 5000
          }
        }
      ]
    }
  ]
}
```

### Creative Submission with Extensions

When submitting creatives, buyers can indicate extension compatibility:

```json
{
  "creative": {
    "format_id": "foundational_immersive_canvas",
    "compatible_extensions": ["*"], // Accepts all extensions
    "assets": {
      // Standard assets that work everywhere
    }
  }
}
```

Or restrict to specific extensions:

```json
{
  "compatible_extensions": [
    "premium_story_canvas",
    "hero_placement_only"
  ]
}
```

##### dooh_digital_billboard
```json
{
  "format_id": "dooh_digital_billboard",
  "name": "Digital Billboard",
  "type": "dooh",
  "publisher": "outdoor_network",
  "description": "Large format digital out-of-home",
  "specs": {
    "resolution": "1920x1080 minimum",
    "duration": "8s rotation",
    "file_format": "JPG or MP4",
    "text_size": "minimum 200px height for legibility"
  },
  "delivery_options": {
    "static_image": {
      "supported": true,
      "lead_time": "48 hours"
    },
    "video": {
      "supported": true,
      "restrictions": ["no audio", "seamless loop"]
    },
    "dynamic_content": {
      "supported": true,
      "triggers": ["weather", "time of day", "sports scores"],
      "api": "publisher REST API"
    }
  },
  "venue_types": ["highway", "transit", "retail"],
  "proof_of_play": "photo capture available"
}
```