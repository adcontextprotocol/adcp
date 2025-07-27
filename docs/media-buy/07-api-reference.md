# AdCP:Buy Specification v2.4

## Table of Contents
1. [Overview](#overview)
2. [Core Concepts](#core-concepts)
3. [API Tools Reference](#api-tools-reference)
4. [Design Decisions](#design-decisions)
5. [Implementation Notes](#implementation-notes)

## Overview

The Advertising Campaign Protocol (AdCP) Buy-side specification defines a standardized interface for programmatic media buying across diverse advertising platforms. This document specifies the protocol for buy-side operations, enabling AI agents and automated systems to discover, plan, purchase, and manage advertising campaigns.

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
    "geography": ["US-CA", "US-NY"],
    "audiences": ["pet_owners"]
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
        "geography": ["US-CA", "US-NY"],
        "audiences": ["pet_owners"],
        "dayparts": ["prime_time"]
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
    "geography": ["US-CA", "US-NY"],
    "audiences": ["pet_owners"],
    "frequency_cap": {
      "impressions": 5,
      "period": "day",
      "per": "user"
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
      "review_feedback": null
    },
    {
      "creative_id": "pet_food_audio_15s",
      "status": "approved",
      "platform_id": "gam_creative_987655",
      "review_feedback": null
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

### Platform Mappings

| AdCP Concept | Google Ad Manager | Kevel | Triton Digital |
|--------------|------------------|-------|----------------|
| Media Buy | Order | Campaign | Campaign |
| Package | Line Item | Flight | Flight |
| Principal | Advertiser | Advertiser | Advertiser |
| Creative | Creative | Creative | Audio Asset |

### Status Normalization

Platforms use different status values. AdCP normalizes to:
- `pending_activation`
- `pending_approval`
- `scheduled`
- `active`
- `paused`
- `completed`
- `failed`

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

Set environment variable `ADCP_DRY_RUN=true` to see platform API calls without execution:
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