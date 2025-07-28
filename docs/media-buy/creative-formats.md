
---
title: Creative Formats
---

# Creative Formats

All creative formats have a unique identifier and specify delivery methods:

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