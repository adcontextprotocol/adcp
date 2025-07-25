# Media Buying Specification

**Status**: Request for Comments  
**Last Updated**: July 25, 2025

## Overview

AdCP:Buy provides a unified protocol for AI-powered media buying across guaranteed and non-guaranteed inventory, fully compatible with OpenRTB 2.6 standards.

## Core Concepts

### Package Types

#### Catalog Packages
- Pre-configured inventory available for immediate activation
- Non-guaranteed delivery competing at specified bid
- No negotiation or approval required
- Compatible with standard OpenRTB creative formats

#### Custom Packages  
- Created in response to specific briefs
- Can offer guaranteed or non-guaranteed delivery
- May require approval workflow
- Support specialized measurement and targeting

### Delivery Commitments

#### Guaranteed Delivery
- Fixed impressions at fixed CPM
- Publisher commits to delivery with makegoods
- Requires approval process
- Higher CPMs typically

#### Non-Guaranteed Delivery
- Best-effort delivery at competitive bid
- No delivery commitments
- Instant activation (usually)
- Market-based pricing with floor guidance

### Creative Formats

The protocol supports both standard IAB/OpenRTB specifications and custom publisher formats:

#### Standard Formats (IAB/OpenRTB 2.6)

##### Video
```json
{
  "format_type": "standard",
  "format_id": "iab_video_standard",
  "mimes": ["video/mp4", "video/webm"],
  "minduration": 5,
  "maxduration": 30,
  "protocols": [2, 3, 5, 6, 7, 8],  // VAST 2.0-4.2
  "w": 1920,
  "h": 1080,
  "placement": 1,  // In-stream
  "playbackmethod": [1, 2],  // Auto-play
  "api": [1, 2, 7]  // VPAID, OMID
}
```

#### Custom Publisher Formats

Publishers can define custom creative formats for unique inventory:

##### Example: Yahoo Edge-to-Edge
```json
{
  "format_type": "custom",
  "format_id": "yahoo_edge_to_edge",
  "name": "Yahoo Edge-to-Edge Mobile",
  "description": "Full-width mobile video that expands edge-to-edge",
  "assets": {
    "primary_video": {
      "mimes": ["video/mp4"],
      "aspect_ratios": ["9:16", "1:1"],
      "min_duration": 6,
      "max_duration": 15,
      "max_file_size_mb": 50
    },
    "end_card": {
      "mimes": ["image/jpeg", "image/png"],
      "w": 1080,
      "h": 1920
    }
  },
  "technical_requirements": {
    "viewability": "100% in-view required",
    "audio": "muted by default",
    "interaction": "tap to unmute"
  }
}
```

##### Example: CTV Pause Ad
```json
{
  "format_type": "custom", 
  "format_id": "ctv_pause_ad",
  "name": "CTV Pause Screen Overlay",
  "description": "L-shaped overlay shown when content is paused",
  "assets": {
    "overlay_image": {
      "mimes": ["image/png"],
      "w": 640,
      "h": 1080,
      "transparency": "required",
      "position": "right_side"
    },
    "brand_logo": {
      "mimes": ["image/png"],
      "max_w": 200,
      "max_h": 100
    }
  },
  "delivery_context": {
    "trigger": "user_pause",
    "duration": "while_paused",
    "dismissible": false
  }
}
```

#### Audio (OpenRTB 2.6)
```json
{
  "mimes": ["audio/mp3", "audio/mpeg"],
  "minduration": 15,
  "maxduration": 60,
  "protocols": [9, 10],  // DAAST 1.0, 1.1
  "api": [1, 2, 3],
  "stitched": 1,  // Server-side insertion
  "nvol": 2  // Volume normalized
}
```

#### Display Banner
```json
{
  "w": [300, 728, 320],
  "h": [250, 90, 50],
  "mimes": ["image/jpeg", "image/png", "text/html"],
  "api": [5, 6, 7]  // MRAID, OMID
}
```

#### DOOH
```json
{
  "mimes": ["image/jpeg", "video/mp4"],
  "w": 1920,
  "h": 1080,
  "duration": 10,  // Display seconds
  "pxratio": 1.0,
  "venuetypetax": 2,  // OpenOOH
  "venuetype": ["transit/airport"]
}
```

## API Specification

### get_packages

Discovers available packages based on media buy criteria.

#### Request
```json
{
  "brief": "Optional natural language campaign context",
  "budget": 150000,
  "currency": "USD",
  "start_time": "2025-07-01T00:00:00Z",
  "end_time": "2025-07-31T23:59:59Z",
  
  "targeting": {
    "geo": ["US"],
    "device_types": [1, 2, 3],  // OpenRTB device types
    "provided_signals": [
      {
        "id": "auto_intenders_q3",
        "required_aee_fields": "RampID or ID5",
        "description": "Auto purchase intenders"
      }
    ],
    "user": {
      "geo": {
        "country": "US",
        "region": ["CA", "NY", "TX"]
      }
    },
    "content": {
      "cat": ["IAB17"],  // Sports content
      "context": 1  // Video content
    },
    "bcat": ["IAB23", "IAB24"],  // No gambling/alcohol
    "badv": ["competitor.com"]
  },
  
  "creatives": [
    {
      "id": "cr_video_30s",
      "format_type": "standard",
      "format_id": "iab_video_standard",
      "media_type": "video",
      "mime": "video/mp4",
      "dur": 30,
      "w": 1920,
      "h": 1080,
      "bitrate": 2000,
      "api": [7],  // OMID
      "companionad": {
        "id": "comp_300x250",
        "w": 300,
        "h": 250,
        "mime": "image/jpeg"
      }
    },
    {
      "id": "cr_edge_to_edge",
      "format_type": "custom",
      "format_id": "yahoo_edge_to_edge",
      "assets": {
        "primary_video": {
          "url": "https://cdn.brand.com/edge_video.mp4",
          "duration": 15,
          "aspect_ratio": "9:16"
        },
        "end_card": {
          "url": "https://cdn.brand.com/end_card.jpg"
        }
      }
    },
    {
      "id": "cr_pause_ad",
      "format_type": "custom",
      "format_id": "ctv_pause_ad",
      "assets": {
        "overlay_image": {
          "url": "https://cdn.brand.com/pause_overlay.png",
          "w": 640,
          "h": 1080
        },
        "brand_logo": {
          "url": "https://cdn.brand.com/logo.png"
        }
      }
    }
  ],
  
  "measurement": {
    "method": "incrementality",
    "vendor": "moat",
    "minimum_impressions_per_cell": 50000
  },
  
  "preferences": {
    "delivery_types": ["guaranteed", "non_guaranteed"],
    "max_packages": 10,
    "min_daily_impressions": 100000
  }
}
```

#### Response
```json
{
  "query_id": "q_12345",
  "valid_until": "2025-06-20T00:00:00Z",
  "packages": [
    {
      "package_id": "premium_sports_guaranteed",
      "type": "custom",
      "name": "Premium Sports Content - Guaranteed",
      "delivery_type": "guaranteed",
      "impressions": 2000000,
      "cpm": 28.00,
      "total_cost": 56000,
      "currency": "USD",
      
      "inventory": {
        "channels": ["ESPN", "Fox Sports"],
        "content_categories": ["IAB17-40", "IAB17-18"],
        "device_types": [3],  // CTV
        "geo": ["US"]
      },
      
      "creative_compatibility": {
        "cr_video_30s": {
          "compatible": true,
          "requires_approval": true,
          "approval_time": "4h",
          "technical_checks": {
            "ssl": "required",
            "vast_version": "4.1+"
          }
        },
        "cr_edge_to_edge": {
          "compatible": true,
          "requires_approval": true,
          "approval_time": "2h",
          "format_match": "exact",
          "notes": "Custom format fully supported"
        },
        "cr_pause_ad": {
          "compatible": false,
          "reason": "Pause ads only available on CTV inventory"
        }
      },
      
      "targeting_capabilities": {
        "provided_signals": {
          "supported": ["auto_intenders_q3"],
          "match_rate": 0.15
        },
        "frequency_cap": {
          "supported": true,
          "min_hours": 1,
          "max_impressions": 10
        }
      },
      
      "measurement": {
        "reporting_granularity": "hourly",
        "viewability": {
          "vendor": "moat",
          "predicted_rate": 0.95
        }
      }
    },
    {
      "package_id": "audio_streaming_non_guaranteed",
      "type": "catalog",
      "name": "Audio Streaming Network",
      "delivery_type": "non_guaranteed",
      "impressions": "best_effort",
      
      "pricing": {
        "floor_cpm": 8.00,
        "suggested_cpm": 12.00,
        "currency": "USD",
        "bid_guidance": {
          "p25": 9.50,
          "p50": 12.00,
          "p75": 15.00,
          "p90": 18.00
        }
      },
      
      "delivery_estimates": {
        "at_floor": {
          "impressions": 100000,
          "win_rate": 0.05
        },
        "at_suggested": {
          "impressions": 1500000,
          "win_rate": 0.35
        }
      },
      
      "creative_compatibility": {
        "cr_audio_15s": {
          "compatible": true,
          "requires_approval": false,
          "pre_approved_advertiser": true
        }
      },
      
      "inventory": {
        "feed_types": [1, 3],  // Music, Podcast
        "publishers": ["spotify", "pandora", "iheartradio"],
        "content_language": ["en", "es"]
      }
    }
  ],
  
  "recommendations": {
    "optimal_mix": [
      {
        "package_id": "premium_sports_guaranteed",
        "budget": 56000,
        "reason": "Ensures 2MM impressions with target audience"
      },
      {
        "package_id": "audio_streaming_non_guaranteed",
        "budget": 30000,
        "suggested_cpm": 12.00,
        "reason": "Extends reach to audio listeners"
      }
    ],
    "warnings": [
      "cr_video_30s requires approval - submit by 2025-06-26",
      "Audio inventory has 24-48h impression delay"
    ]
  }
}
```

### create_media_buy

Creates a media buy with selected packages.

#### Request
```json
{
  "query_id": "q_12345",  // Optional reference
  "selected_packages": [
    {
      "package_id": "premium_sports_guaranteed",
      "budget": 56000
    },
    {
      "package_id": "audio_streaming_non_guaranteed",
      "budget": 30000,
      "max_cpm": 15.00,
      "target_impressions": 2000000,
      "frequency_cap": {
        "max_impressions": 3,
        "time_window": "24h"
      }
    }
  ],
  
  "creative_assignments": [
    {
      "creative_id": "cr_video_30s",
      "package_ids": ["premium_sports_guaranteed"]
    },
    {
      "creative_id": "cr_audio_15s",
      "package_ids": ["audio_streaming_non_guaranteed"]
    }
  ],
  
  "measurement": {
    "attribution_window": "7d",
    "reporting_endpoint": "https://measure.brand.com/adcp",
    "expose_user_ids": ["RampID", "ID5"]
  },
  
  "flight": {
    "start_time": "2025-07-01T00:00:00Z",
    "end_time": "2025-07-31T23:59:59Z",
    "timezone": "America/New_York"
  },
  
  "billing": {
    "entity": "Nike Inc.",
    "po_number": "NIKE-2025-07-001",
    "contact_email": "media@nike.com"
  }
}
```

#### Response
```json
{
  "media_buy_id": "buy_12345",
  "status": "partially_active",
  "created_at": "2025-06-15T10:00:00Z",
  
  "packages": [
    {
      "package_id": "premium_sports_guaranteed",
      "status": "pending_creative_approval",
      "creative_review": {
        "cr_video_30s": {
          "status": "in_review",
          "eta": "2025-06-15T14:00:00Z"
        }
      }
    },
    {
      "package_id": "audio_streaming_non_guaranteed",
      "status": "active",
      "activation_time": "2025-06-15T10:05:00Z",
      "current_metrics": {
        "win_rate": 0.31,
        "avg_cpm": 11.85,
        "impressions_delivered": 0
      }
    }
  ],
  
  "next_steps": [
    "Creative cr_video_30s under review - check status in 4 hours",
    "Audio package active and bidding in market"
  ]
}
```

### check_media_buy_status

#### Request
```json
{
  "media_buy_id": "buy_12345"
}
```

#### Response
```json
{
  "media_buy_id": "buy_12345",
  "status": "live",
  "flight_progress": {
    "start_time": "2025-07-01T00:00:00Z",
    "current_time": "2025-07-15T14:30:00Z",
    "end_time": "2025-07-31T23:59:59Z",
    "percentage_complete": 48
  },
  
  "overall_metrics": {
    "total_spend": 43000,
    "total_impressions": 1850000,
    "avg_cpm": 23.24,
    "pacing": "slightly_behind"
  },
  
  "packages": [
    {
      "package_id": "premium_sports_guaranteed",
      "status": "delivering",
      "delivery_type": "guaranteed",
      "metrics": {
        "impressions_delivered": 950000,
        "impressions_guaranteed": 2000000,
        "spend": 26600,
        "pacing": "on_track",
        "viewability_rate": 0.96
      }
    },
    {
      "package_id": "audio_streaming_non_guaranteed",
      "status": "delivering",
      "delivery_type": "non_guaranteed",
      "metrics": {
        "impressions_delivered": 900000,
        "spend": 16400,
        "avg_cpm": 18.22,
        "win_rate": 0.28,
        "listen_through_rate": 0.89
      }
    }
  ]
}
```

### update_media_buy_performance_index

#### Request
```json
{
  "media_buy_id": "buy_12345",
  "reporting_period": {
    "start": "2025-07-01T00:00:00Z",
    "end": "2025-07-14T23:59:59Z"
  },
  "package_performance": [
    {
      "package_id": "premium_sports_guaranteed",
      "performance_index": 145,
      "confidence_interval": [125, 165],
      "sample_size": 45000
    },
    {
      "package_id": "audio_streaming_non_guaranteed",
      "performance_index": 92,
      "confidence_interval": [78, 106],
      "sample_size": 38000
    }
  ],
  "notes": "Sports package showing strong incremental lift"
}
```

### Additional Endpoints

#### get_publisher_creative_formats (NEW)

Returns all creative formats supported by a publisher.

#### Request
```json
{
  "publisher": "yahoo",
  "media_types": ["video", "display"],
  "include_standard_formats": true
}
```

#### Response
```json
{
  "publisher": "yahoo",
  "formats": [
    {
      "format_type": "custom",
      "format_id": "yahoo_edge_to_edge",
      "name": "Edge-to-Edge Mobile Video",
      "media_type": "video",
      "description": "Full-width mobile video that expands edge-to-edge on scroll",
      "preview_url": "https://yahoo.com/formats/edge-to-edge",
      "assets": {
        "primary_video": {
          "required": true,
          "mimes": ["video/mp4"],
          "aspect_ratios": ["9:16", "1:1", "4:5"],
          "min_duration": 6,
          "max_duration": 15,
          "max_file_size_mb": 50,
          "audio": "optional"
        },
        "end_card": {
          "required": false,
          "mimes": ["image/jpeg", "image/png"],
          "sizes": [{"w": 1080, "h": 1920}]
        },
        "logo": {
          "required": true,
          "mimes": ["image/png"],
          "max_size": {"w": 200, "h": 100},
          "transparency": "required"
        }
      },
      "technical_specs": {
        "viewability": "100% in-view autoplay",
        "interaction": "tap for sound",
        "measurement": "MOAT, IAS supported"
      },
      "available_on": ["mobile_web", "mobile_app"]
    },
    {
      "format_type": "custom", 
      "format_id": "nyt_flex_xl",
      "name": "NYT Flex Frame XL",
      "media_type": "display",
      "description": "Expandable rich media unit with video",
      "assets": {
        "collapsed_state": {
          "required": true,
          "size": {"w": 970, "h": 250},
          "mimes": ["text/html", "image/jpeg"]
        },
        "expanded_state": {
          "required": true,
          "size": {"w": 970, "h": 550},
          "mimes": ["text/html"],
          "can_include_video": true
        }
      }
    },
    {
      "format_type": "standard",
      "format_id": "iab_video_standard",
      "name": "Standard In-Stream Video",
      "media_type": "video",
      "spec": {
        // Standard OpenRTB video spec
      }
    }
  ]
}
```

## AEE Integration

When using provided signals, publishers make OpenRTB requests to the Principal's AEE:

```json
{
  "id": "imp_12345",
  "imp": [{
    "id": "1",
    "video": {
      "mimes": ["video/mp4"],
      "protocols": [2, 3],
      "w": 1920,
      "h": 1080
    }
  }],
  "user": {
    "ext": {
      "rampid": "XY123456"
    }
  },
  "ext": {
    "acp": {
      "media_buy_id": "buy_12345",
      "packages": ["premium_sports_guaranteed"],
      "provided_signals": ["auto_intenders_q3"]
    }
  }
}
```

AEE Response:
```json
{
  "signals": {
    "present": ["auto_intenders_q3"],
    "absent": []
  },
  "packages": {
    "eligible": ["premium_sports_guaranteed"]
  }
}
```

## Standard Creative Formats Reference

The protocol adopts these IAB standard formats as the baseline:

### Video
- Formats: MP4 (H.264/H.265), WebM (VP8/VP9)
- Resolutions: 1920x1080, 1280x720, 640x480
- Durations: 6s, 15s, 30s, 60s
- Protocols: VAST 2.0-4.2

### Audio  
- Formats: MP3 (128-320kbps), M4A/AAC
- Durations: 15s, 30s, 60s
- Companions: 640x640, 300x250

### Display
- Standard IAB sizes
- HTML5, JPEG, PNG, GIF
- MRAID 3.0 for mobile

### DOOH
- Venue-specific requirements
- Min 1920x1080 for most venues
- 10s standard rotation
- Pre-approval required

## Next Steps

- See the [Sales Agent reference implementation](https://github.com/adcontextprotocol/salesagent)