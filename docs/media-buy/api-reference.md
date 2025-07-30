---
title: API Reference
---

# API Reference

## Table of Contents
1. [Overview](#overview)
2. [Core Concepts](#core-concepts)
3. [API Tools Reference](#api-tools-reference)
4. [Design Decisions](#design-decisions)
5. [Implementation Notes](#implementation-notes)

## Overview

The Advertising Context Protocol (AdCP) Sales Agent specification defines a standardized MCP (Model Context Protocol) interface for programmatic media buying across diverse advertising platforms. This document specifies the protocol for sales agent operations, enabling AI agents and automated systems to discover, plan, purchase, and manage advertising campaigns through MCP tools.

### Goals
- **Platform Agnostic**: Abstract away platform-specific terminology and workflows
- **AI-Friendly**: Natural language discovery with structured execution
- **Complete Lifecycle**: From discovery through optimization
- **Multi-Tenant**: Principal-based isolation for agencies and brands

### Non-Goals
- Real-time bidding (RTB) operations
- Supply-side/publisher operations
- Creative production (only creative submission)

## Core Concepts

### Principal
A Principal represents an authenticated entity (advertiser, agency, or brand) with:
- Unique identifier and access token
- Platform-specific account mappings
- Isolated data access

### Media Buy
A media buy represents a purchased advertising campaign containing:
- One or more packages (flights/line items)
- Total budget and date range
- Global targeting criteria
- Creative assets

### Package
A package represents a specific advertising product within a media buy:
- Product-based pricing (CPM, impressions)
- Optional targeting overlay
- Creative assignments
- Delivery goals

### Design Decision: Package vs Flight Model
**Current Design**: One package = one flight/line item
**Rationale**: Simplifies the model for most use cases
**Trade-off**: Advanced users may want multiple flights per package for:
- A/B testing different creatives
- Time-based segmentation
- Different targeting within same inventory

**For Industry Discussion**: Should we support multiple flights per package?

## API Tools Reference

### 1. discover_products

Discovers available advertising products based on natural language brief.

**Request:**
```json
{
  "campaign_brief": "I want to reach pet owners in California with video ads during prime time"
}
```

**Response:**
```json
{
  "recommended_products": [
    {
      "product_id": "connected_tv_prime",
      "name": "Connected TV - Prime Time",
      "description": "Premium CTV inventory 8PM-11PM PST",
      "min_spend": 10000,
      "cpm_range": {
        "min": 35.00,
        "max": 65.00
      },
      "targeting_available": [
        "geography",
        "interests",
        "demographics",
        "device_types"
      ],
      "formats": ["video"],
      "match_reasons": [
        "Prime time daypart matches request",
        "CTV reaches pet owner households",
        "California geo-targeting available"
      ]
    }
  ]
}
```

**Error Handling:**
- `400 Bad Request`: Brief too vague or short
- `401 Unauthorized`: Invalid authentication
- `500 Internal Server Error`: AI processing failure

### 2. get_avails

Checks availability and pricing for specific products.

**Request:**
```json
{
  "product_ids": ["connected_tv_prime", "streaming_audio_drive"],
  "start_date": "2024-02-01",
  "end_date": "2024-02-14",
  "budget": 50000,
  "targeting_overlay": {
    "geo_country_any_of": ["US"],
    "geo_region_any_of": ["CA", "NY"],
    "audience_segment_any_of": ["3p:pet_owners"]
  }
}
```

**Response:**
```json
{
  "packages": [
    {
      "package_id": "pkg_ctv_prime_ca_ny",
      "product_id": "connected_tv_prime",
      "name": "CTV Prime - CA/NY Pet Owners",
      "impressions": 769230,
      "cpm": 45.00,
      "total_cost": 34615.35,
      "availability": 0.92,
      "targeting_applied": {
        "geo_country_any_of": ["US"],
        "geo_region_any_of": ["CA", "NY"],
        "audience_segment_any_of": ["3p:pet_owners"],
        "dayparting": {
          "presets": ["prime_time"]
        }
      }
    },
    {
      "package_id": "pkg_audio_drive_ca_ny",
      "product_id": "streaming_audio_drive",
      "name": "Streaming Audio - Drive Time",
      "impressions": 625000,
      "cpm": 25.00,
      "total_cost": 15625.00,
      "availability": 0.88
    }
  ],
  "total_budget": 50240.35,
  "total_impressions": 1394230,
  "budget_utilization": 1.005
}
```

**Error Cases:**
- `404 Not Found`: Invalid product IDs
- `400 Bad Request`: Invalid date range or targeting
- `409 Conflict`: No availability for requested criteria

### 3. create_media_buy

Creates a media buy from selected packages.

**Request:**
```json
{
  "packages": ["pkg_ctv_prime_ca_ny", "pkg_audio_drive_ca_ny"],
  "po_number": "PO-2024-Q1-0123",
  "total_budget": 50000,
  "targeting_overlay": {
    "geo_country_any_of": ["US"],
    "geo_region_any_of": ["CA", "NY"],
    "audience_segment_any_of": ["3p:pet_owners"],
    "frequency_cap": {
      "suppress_minutes": 30,
      "scope": "media_buy"
    }
  },
  "pacing": "even",
  "daily_budget": null
}
```

**Response:**
```json
{
  "media_buy_id": "gam_1234567890",
  "status": "pending_activation",
  "creative_deadline": "2024-01-30T23:59:59Z",
  "detail": "Media buy created in Google Ad Manager",
  "next_steps": [
    "Upload creative assets before deadline",
    "Assets will be reviewed by ad server",
    "Campaign will auto-activate after approval"
  ]
}
```

**Platform Behavior:**
- **GAM**: Creates Order with LineItems, requires approval
- **Kevel**: Creates Campaign with Flights, instant activation
- **Triton**: Creates Campaign for audio delivery

### 4. add_creative_assets

Uploads creative assets and assigns to packages.

**Request:**
```json
{
  "media_buy_id": "gam_1234567890",
  "assets": [
    {
      "creative_id": "pet_food_30s_v1",
      "name": "Purina Pet Food - 30s Spot",
      "format": "video",
      "media_url": "https://cdn.example.com/creatives/pet_food_30s.mp4",
      "click_url": "https://www.purina.com/offers/new-year",
      "duration": 30000,
      "width": 1920,
      "height": 1080,
      "package_assignments": ["pkg_ctv_prime_ca_ny"]
    },
    {
      "creative_id": "pet_food_audio_15s",
      "name": "Purina Audio Spot - 15s",
      "format": "audio",
      "media_url": "https://cdn.example.com/creatives/pet_food_15s.mp3",
      "click_url": "https://www.purina.com/offers",
      "duration": 15000,
      "package_assignments": ["pkg_audio_drive_ca_ny"]
    }
  ]
}
```

**Response:**
```json
{
  "asset_statuses": [
    {
      "creative_id": "pet_food_30s_v1",
      "status": "approved",
      "platform_id": "gam_creative_987654",
      "review_feedback": null,
      "suggested_adaptations": [
        {
          "adaptation_id": "adapt_vertical_v1",
          "format_id": "video_vertical_9x16",
          "name": "Mobile Vertical Version",
          "description": "9:16 version optimized for mobile feeds",
          "changes_summary": [
            "Crop to 9:16 aspect ratio",
            "Add captions for sound-off viewing",
            "Optimize for 6-second view"
          ],
          "rationale": "Mobile inventory converts 35% better with vertical format",
          "estimated_performance_lift": 35.0
        }
      ]
    },
    {
      "creative_id": "pet_food_audio_15s",
      "status": "approved",
      "platform_id": "gam_creative_987655",
      "review_feedback": null,
      "suggested_adaptations": []
    }
  ]
}
```

**Platform Validation:**
- Format compatibility (video for CTV, audio for radio)
- Size and duration limits
- Content policies
- Technical specifications

### 5. check_media_buy_status

Monitors the status of a media buy.

**Request:**
```json
{
  "media_buy_id": "gam_1234567890"
}
```

**Response:**
```json
{
  "media_buy_id": "gam_1234567890",
  "status": "active",
  "last_updated": "2024-02-01T08:00:00Z",
  "package_statuses": [
    {
      "package_id": "pkg_ctv_prime_ca_ny",
      "status": "delivering",
      "pacing": "on_track",
      "delivery_percentage": 12.5
    },
    {
      "package_id": "pkg_audio_drive_ca_ny",
      "status": "delivering",
      "pacing": "slightly_behind",
      "delivery_percentage": 10.2
    }
  ]
}
```

**Status Values:**
- `pending_activation`: Awaiting creatives or approval
- `pending_approval`: Under platform review
- `scheduled`: Approved, waiting for start date
- `active`: Currently eligible to deliver
- `paused`: Temporarily stopped
- `completed`: Finished delivery
- `failed`: Critical error

### 6. get_media_buy_delivery

Retrieves delivery metrics for reporting.

**Request:**
```json
{
  "media_buy_id": "gam_1234567890",
  "start_date": "2024-02-01",
  "end_date": "2024-02-07"
}
```

**Response:**
```json
{
  "media_buy_id": "gam_1234567890",
  "reporting_period": {
    "start": "2024-02-01T00:00:00Z",
    "end": "2024-02-07T23:59:59Z"
  },
  "currency": "USD",
  "totals": {
    "impressions": 450000,
    "spend": 16875.00,
    "clicks": 900,
    "ctr": 0.002,
    "video_completions": 315000,
    "completion_rate": 0.70
  },
  "by_package": [
    {
      "package_id": "pkg_ctv_prime_ca_ny",
      "impressions": 250000,
      "spend": 11250.00,
      "clicks": 500,
      "video_completions": 175000,
      "pacing_index": 0.93
    },
    {
      "package_id": "pkg_audio_drive_ca_ny",
      "impressions": 200000,
      "spend": 5625.00,
      "clicks": 400,
      "pacing_index": 0.88
    }
  ],
  "daily_breakdown": [
    {
      "date": "2024-02-01",
      "impressions": 64285,
      "spend": 2410.71
    }
  ]
}
```

### 7. update_media_buy

Updates campaign and package settings using PATCH semantics.

**Request Example 1 - Campaign Pause:**
```json
{
  "media_buy_id": "gam_1234567890",
  "active": false
}
```

**Response:**
```json
{
  "status": "accepted",
  "implementation_date": "2024-02-08T00:00:00Z",
  "detail": "Order paused in Google Ad Manager",
  "affected_packages": ["pkg_ctv_prime_ca_ny", "pkg_audio_drive_ca_ny"]
}
```

**Request Example 2 - Complex Update:**
```json
{
  "media_buy_id": "gam_1234567890",
  "flight_end_date": "2024-02-28",
  "total_budget": 75000,
  "packages": [
    {
      "package_id": "pkg_ctv_prime_ca_ny",
      "budget": 45000,
      "pacing": "front_loaded"
    },
    {
      "package_id": "pkg_audio_drive_ca_ny",
      "active": false
    }
  ]
}
```

**PATCH Semantics:**
- Only included fields are modified
- Omitted packages remain unchanged
- Null values clear/reset fields (where applicable)

### 8. update_package

Focused tool for package-only updates.

**Request:**
```json
{
  "media_buy_id": "gam_1234567890",
  "packages": [
    {
      "package_id": "pkg_ctv_prime_ca_ny",
      "active": true,
      "impressions": 500000,
      "daily_impressions": 35000,
      "creative_ids": ["pet_food_30s_v2", "pet_food_15s_v1"]
    },
    {
      "package_id": "pkg_new_package",
      "active": false
    }
  ]
}
```

**Design Note**: Adding new packages post-creation not yet supported. Under consideration for future version.

### 9. update_performance_index

Provides performance feedback for AI optimization.

**Request:**
```json
{
  "media_buy_id": "gam_1234567890",
  "performance_data": [
    {
      "product_id": "connected_tv_prime",
      "performance_index": 1.15,
      "confidence_score": 0.92,
      "feedback": "Strong viewability and completion rates"
    },
    {
      "product_id": "streaming_audio_drive",
      "performance_index": 0.85,
      "confidence_score": 0.88,
      "feedback": "Lower than expected reach in target demo"
    }
  ]
}
```

**Response:**
```json
{
  "status": "accepted",
  "optimization_actions": [
    {
      "package_id": "pkg_ctv_prime_ca_ny",
      "action": "increase_budget_allocation",
      "reason": "High performance index"
    },
    {
      "package_id": "pkg_audio_drive_ca_ny",
      "action": "review_targeting",
      "reason": "Below baseline performance"
    }
  ]
}
```

### 10. get_all_media_buy_delivery

Retrieves delivery metrics for all active media buys owned by the principal. This is optimized for performance by batching requests.

**Request:**
```json
{
  "today": "2024-02-08",
  "media_buy_ids": ["gam_1234567890", "gam_9876543210"]  // Optional - omit to get all
}
```

**Response:**
```json
{
  "deliveries": [
    {
      "media_buy_id": "gam_1234567890",
      "status": "delivering",
      "spend": 35000.50,
      "impressions": 3500000,
      "pacing": "on_track",
      "days_elapsed": 7,
      "total_days": 14
    },
    {
      "media_buy_id": "gam_9876543210", 
      "status": "completed",
      "spend": 50000.00,
      "impressions": 5000000,
      "pacing": "on_track",
      "days_elapsed": 30,
      "total_days": 30
    }
  ],
  "total_spend": 85000.50,
  "total_impressions": 8500000,
  "active_count": 1,
  "summary_date": "2024-02-08"
}
```

### 10. get_creatives

Lists creative assets for a principal or media buy.

**Request:**
```json
{
  "media_buy_id": "gam_1234567890",  // Optional - filter by media buy
  "status": "approved",              // Optional - filter by status
  "format": "video"                  // Optional - filter by format
}
```

**Response:**
```json
{
  "creatives": [
    {
      "creative_id": "pet_food_30s_v2",
      "name": "Premium Pet Food - Hero 30s",
      "format": "video",
      "status": "approved",
      "created_at": "2024-02-01T10:00:00Z",
      "associations": [
        {
          "media_buy_id": "gam_1234567890",
          "package_id": "pkg_ctv_prime_ca_ny"
        }
      ]
    }
  ]
}
```

### 11. approve_adaptation

Approves or rejects a suggested creative adaptation.

**Request:**
```json
{
  "creative_id": "pet_food_30s_v1",
  "adaptation_id": "adapt_vertical_v1",
  "approve": true,
  "modifications": {
    "name": "Pet Food Hero - Mobile Vertical"
  }
}
```

**Response:**
```json
{
  "success": true,
  "new_creative": {
    "creative_id": "pet_food_30s_vertical_auto",
    "format_id": "video_vertical_9x16",
    "content_uri": "https://cdn.publisher.com/adapted/pet_food_vertical.mp4",
    "name": "Pet Food Hero - Mobile Vertical"
  },
  "status": {
    "creative_id": "pet_food_30s_vertical_auto",
    "status": "approved"
  },
  "message": "Adaptation approved and creative generated"
}
```

### 12. review_pending_creatives (Admin Only)

Reviews and approves/rejects pending creatives.

**Request:**
```json
{
  "creative_id": "pet_food_30s_v3",
  "action": "approve",
  "reason": "Meets brand guidelines"
}
```

**Response:**
```json
{
  "creative_id": "pet_food_30s_v3",
  "status": "approved",
  "reviewed_by": "admin",
  "reviewed_at": "2024-02-08T14:30:00Z"
}
```

### 13. list_human_tasks (Admin Only)

Lists pending human approval tasks.

**Request:**
```json
{
  "status": "pending",  // Optional - filter by status
  "task_type": "media_buy_approval"  // Optional - filter by type
}
```

**Response:**
```json
{
  "tasks": [
    {
      "task_id": "task_001",
      "task_type": "media_buy_approval",
      "status": "pending",
      "created_at": "2024-02-08T10:00:00Z",
      "principal_id": "nike",
      "description": "Approve media buy creation: $50,000 CTV campaign",
      "metadata": {
        "media_buy_id": "pending_mb_001",
        "total_budget": 50000,
        "products": ["connected_tv_prime"]
      }
    }
  ]
}
```

### 14. complete_human_task (Admin Only)

Completes a human approval task.

**Request:**
```json
{
  "task_id": "task_001",
  "action": "approve",
  "notes": "Budget verified, targeting appropriate"
}
```

**Response:**
```json
{
  "task_id": "task_001",
  "status": "completed",
  "completed_by": "admin",
  "completed_at": "2024-02-08T14:45:00Z",
  "result": {
    "media_buy_id": "gam_1234567890",
    "status": "active"
  }
}
```

### 15. get_all_media_buy_delivery (Admin Only)

Retrieves delivery data for all active media buys across all principals.

**Request:**
```json
{
  "today": "2024-02-08",
  "status": "active"  // Optional - filter by status
}
```

**Response:** Same format as get_media_buy_delivery but includes all media buys.

### 16. list_products

Lists available advertising products, optionally filtered by brief and principal context.

**Request:**
```json
{
  "principal": {  // Optional - provides context for personalized results
    "principal_id": "nike",
    "organization": "Nike Inc.",
    "ad_server_mappings": {
      "gam": {
        "network_code": "123456",
        "advertiser_id": "nike_sports_2024"
      }
    }
  },
  "brief": "Looking for premium sports inventory",  // Optional - natural language brief
  "category": "video",  // Optional - filter by category
  "min_budget": 1000,   // Optional - filter by minimum budget
  "formats": ["video"]  // Optional - filter by formats
}
```

**Response:**
```json
{
  "products": [
    {
      "product_id": "connected_tv_prime",
      "name": "Connected TV - Prime Time",
      "description": "Premium CTV inventory 8PM-11PM",
      "formats": [{
        "format_id": "video_standard",
        "name": "Standard Video"
      }],
      "implementation_config": {
        "gam": {
          "placement_ids": ["123456"],
          "ad_unit_paths": ["/video/ctv/prime"],
          "targeting_keys": {"daypart": "prime"}
        }
      },
      "delivery_type": "guaranteed",
      "is_fixed_price": true,
      "cpm": 45.00,
      "min_spend": 10000,
      "match_score": 0.92,  // If brief was provided
      "match_reasons": [    // If brief was provided
        "Sports content alignment",
        "Premium inventory matches request"
      ]
    }
  ]
}
```

## Design Decisions

### 1. Package Model (Single Flight)

**Decision**: Each package maps to exactly one flight/line item.

**Pros:**
- Simpler mental model
- Cleaner API
- Covers 90% of use cases

**Cons:**
- No built-in A/B testing at package level
- Can't split package across time periods
- May require multiple packages for complex scenarios

**For Discussion**: Should v3 support multi-flight packages?

### 2. PATCH Update Semantics

**Decision**: Updates use PATCH semantics (only included fields change).

**Rationale:**
- Safety: Can't accidentally affect omitted items
- Standard: Follows REST conventions
- Flexible: Update any subset

**Alternative Considered**: PUT/Replace semantics
- Risk: Forgetting a package would delete it
- Complexity: Must include entire state

### 3. Soft Delete via Pause

**Decision**: No hard delete; use `active: false` to remove from delivery.

**Rationale:**
- Preserves reporting history
- Allows reactivation
- Prevents accidental data loss

**Trade-off**: May accumulate paused packages over time.

### 4. Principal-Based Multi-Tenancy

**Decision**: All operations scoped to authenticated principal.

**Implementation:**
- Header-based auth: `x-adcp-auth: <token>`
- Principal owns all created resources
- No cross-principal access

**Benefits:**
- Simple security model
- Clear ownership
- Agency-friendly

### 5. Natural Language Discovery

**Decision**: First tool uses natural language brief.

**Rationale:**
- AI-native interface
- Abstracts platform complexity
- Enables conversational planning

**Trade-off**: Less precise than structured search.

## Implementation Notes

## Human-in-the-Loop (HITL) Operations

The AdCP:Buy protocol includes tools for managing operations that require human intervention.

### create_human_task

Creates a task requiring human intervention. Used internally by the system when manual approval is required.

**Request:**
```json
{
  "task_type": "manual_approval",
  "priority": "high",
  "media_buy_id": "gam_12345",
  "operation": "create_media_buy",
  "error_detail": "Publisher requires manual approval for all media buy creation",
  "context_data": {
    "request": {...},
    "principal_id": "acme_corp"
  },
  "due_in_hours": 4
}
```

**Response:**
```json
{
  "task_id": "task_a1b2c3d4",
  "status": "pending",
  "due_by": "2024-02-15T16:00:00Z"
}
```

### get_pending_tasks

Retrieves pending human tasks. Principals see their own tasks; admins see all tasks.

**Request:**
```json
{
  "task_type": "manual_approval",
  "priority": "high",
  "include_overdue": true
}
```

**Response:**
```json
{
  "tasks": [
    {
      "task_id": "task_a1b2c3d4",
      "task_type": "manual_approval",
      "principal_id": "acme_corp",
      "status": "pending",
      "priority": "high",
      "operation": "create_media_buy",
      "error_detail": "Publisher requires manual approval",
      "created_at": "2024-02-15T12:00:00Z",
      "due_by": "2024-02-15T16:00:00Z"
    }
  ],
  "total_count": 1,
  "overdue_count": 0
}
```

### assign_task (Admin Only)

Assigns a task to a human operator for processing.

**Request:**
```json
{
  "task_id": "task_a1b2c3d4",
  "assigned_to": "ops@publisher.com"
}
```

**Response:**
```json
{
  "status": "success",
  "detail": "Task task_a1b2c3d4 assigned to ops@publisher.com"
}
```

### complete_task (Admin Only)

Completes a human task with resolution. For manual approval tasks, approved operations are executed automatically.

**Request:**
```json
{
  "task_id": "task_a1b2c3d4",
  "resolution": "approved",
  "resolution_detail": "Verified budget and targeting parameters",
  "resolved_by": "ops@publisher.com"
}
```

**Response:**
```json
{
  "status": "success",
  "detail": "Task task_a1b2c3d4 completed with resolution: approved"
}
```

**Resolution Values:**
- `approved`: Execute the deferred operation
- `rejected`: Cancel the operation
- `completed`: Generic task completion
- `cannot_complete`: Task cannot be resolved

### Platform Mappings

| AdCP Concept | Google Ad Manager | Kevel | Triton Digital |
|--------------|------------------|-------|----------------|
| Media Buy | Order | Campaign | Campaign |
| Package | Line Item | Flight | Flight |
| Principal | Advertiser | Advertiser | Advertiser |
| Creative | Creative | Creative | Audio Asset |

### Status Normalization

Platforms use different status values. AdCP normalizes to:
- `pending_activation` - Awaiting creative assets
- `pending_approval` - Under review by ad server
- `pending_manual` - Awaiting human approval (HITL)
- `pending_permission` - Blocked by permissions
- `scheduled` - Future start date
- `active` - Currently delivering
- `paused` - Temporarily stopped
- `completed` - Finished delivering
- `failed` - Error state

**Important**: Pending states are normal operational states, not errors. Orchestrators must handle them gracefully.

### Error Handling

All tools return errors in consistent format:
```json
{
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "Start date must be in the future",
    "field": "start_date",
    "suggestion": "Use a date after 2024-02-08"
  }
}
```

### Dry Run Mode

Set environment variable `AdCP_DRY_RUN=true` to see platform API calls without execution:
```
[dry-run] Would call: POST https://api.kevel.co/v1/campaign
[dry-run]   Campaign Payload: {
[dry-run]     'AdvertiserId': 12345,
[dry-run]     'Name': 'AdCP Campaign PO-2024-Q1-0123',
[dry-run]     'StartDate': '2024-02-01T00:00:00',
[dry-run]     'EndDate': '2024-02-14T23:59:59',
[dry-run]     'DailyBudget': 3571.43,
[dry-run]     'IsActive': true
[dry-run]   }
```

## Data Models

### Targeting Schema

The Targeting object uses any_of/none_of patterns for flexible audience selection:

```typescript
interface Targeting {
  // Geographic targeting - aligned with OpenRTB
  geo_country_any_of?: string[];     // ISO codes: ["US", "CA", "GB"]
  geo_country_none_of?: string[];
  
  geo_region_any_of?: string[];      // Region/state codes: ["NY", "CA", "ON"]
  geo_region_none_of?: string[];
  
  geo_metro_any_of?: string[];       // Metro/DMA codes: ["501", "803"]
  geo_metro_none_of?: string[];
  
  geo_city_any_of?: string[];        // City names: ["New York", "Los Angeles"]
  geo_city_none_of?: string[];
  
  geo_zip_any_of?: string[];         // Postal codes: ["10001", "90210"]
  geo_zip_none_of?: string[];
  
  // Device and platform targeting
  device_type_any_of?: string[];     // ["mobile", "desktop", "tablet", "ctv", "audio", "dooh"]
  device_type_none_of?: string[];
  
  os_any_of?: string[];              // ["iOS", "Android", "Windows", "macOS"]
  os_none_of?: string[];
  
  browser_any_of?: string[];         // ["Chrome", "Safari", "Firefox", "Edge"]
  browser_none_of?: string[];
  
  connection_type_any_of?: string[]; // ["ethernet", "wifi", "cellular"]
  connection_type_none_of?: string[];
  
  // Content and contextual targeting
  content_category_any_of?: string[];    // IAB categories: ["IAB17", "IAB19"]
  content_category_none_of?: string[];
  
  content_genre_any_of?: string[];       // ["news", "sports", "music"]
  content_genre_none_of?: string[];
  
  content_rating_any_of?: string[];      // ["G", "PG", "PG-13", "R"]
  content_rating_none_of?: string[];
  
  language_any_of?: string[];            // ISO 639-1: ["en", "es", "fr"]
  language_none_of?: string[];
  
  // Audience targeting
  audience_segment_any_of?: string[];    // ["1p:loyalty", "3p:auto_intenders"]
  audience_segment_none_of?: string[];
  
  // Media type targeting
  media_type_any_of?: string[];          // ["video", "audio", "display", "native"]
  media_type_none_of?: string[];
  
  // Time-based targeting
  dayparting?: Dayparting;               // Structured schedule (see below)
  
  // Frequency control
  frequency_cap?: FrequencyCap;          // Simple suppression (see below)
  
  // Platform-specific custom targeting
  custom?: {[key: string]: any};         // Platform-specific options
}

interface Dayparting {
  timezone: string;                      // "America/New_York"
  schedules: DaypartSchedule[];
  presets?: string[];                    // ["drive_time_morning"] for audio
}

interface DaypartSchedule {
  days: number[];                        // [1,2,3,4,5] (0=Sunday, 6=Saturday)
  start_hour: number;                    // 0-23
  end_hour: number;                      // 0-23
  timezone?: string;                     // Override default timezone
}

interface FrequencyCap {
  suppress_minutes: number;              // Suppress after impression for N minutes
  scope: "media_buy" | "package";        // Apply at campaign or flight level
}
```

**Note**: Basic frequency capping provides simple time-based suppression. More sophisticated frequency management (cross-device, complex attribution windows) is handled by the AEE layer.

### Package Update Schema

For PATCH updates to packages within a media buy:

```typescript
interface PackageUpdate {
  package_id: string;              // Required: which package to update
  active?: boolean;                // Pause/resume package
  budget?: number;                 // New budget in dollars
  impressions?: number;            // Direct impression goal
  cpm?: number;                    // Update CPM rate
  daily_budget?: number;           // Daily spend cap
  daily_impressions?: number;      // Daily impression cap
  pacing?: "even" | "asap" | "front_loaded";
  creative_ids?: string[];         // Update creative assignments
  targeting_overlay?: Targeting;   // Package-specific targeting
}
```

## Future Considerations

### For Industry Feedback

1. **Multi-Flight Packages**: Should packages support multiple flights for testing?
2. **Budget Pacing Curves**: Support custom pacing beyond even/ASAP?
3. **Cross-Package Optimization**: Automatic budget reallocation?
4. **Competitive Separation**: Prevent same-advertiser collisions?
5. **Make-Good Handling**: Automated under-delivery compensation?

### Planned Enhancements

1. **add_packages**: Add packages to existing media buy
2. **clone_media_buy**: Duplicate successful campaigns
3. **get_recommendations**: AI-driven optimization suggestions
4. **bulk_operations**: Update multiple media buys
5. **templates**: Save and reuse campaign structures

## Conclusion

AdCP:Buy provides a unified, AI-friendly interface for programmatic media buying. By abstracting platform complexity while preserving capabilities, it enables new levels of automation and optimization in digital advertising.

For questions or contributions: https://github.com/adcp-protocol/specs