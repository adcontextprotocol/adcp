---
title: Media Buy Lifecycle
---

# Media Buy Lifecycle

## Overview

The AdCP:Buy protocol provides a unified interface for managing media buys across multiple advertising platforms. This document details the media buy lifecycle and management capabilities.

## Media Buy Lifecycle

### 1. Creation (`create_media_buy`)
Creates a new media buy (campaign/order) with one or more packages (flights/line items).

**Request Parameters:**
- `packages`: List of media packages to purchase
- `po_number`: Optional purchase order number
- `total_budget`: Total budget for the buy
- `targeting_overlay`: Targeting criteria to apply

**Platform Mapping:**
- **Google Ad Manager**: Creates an Order with LineItems
- **Kevel**: Creates a Campaign with Flights
- **Triton Digital**: Creates a Campaign with Flights

### 2. Creative Upload (`add_creative_assets`)
Uploads creative assets and associates them with packages.

**Supported Formats:**
- **Image**: Supported by GAM, Kevel
- **Video**: Supported by GAM, Kevel
- **Audio**: Supported by Triton Digital
- **Custom**: Supported by Kevel (template-based)

### 3. Status Monitoring (`check_media_buy_status`)
Returns the current status of a media buy.

**Status Values:**
- `pending_activation`: Awaiting creative assets
- `pending_approval`: Under review
- `active`: Currently delivering
- `paused`: Temporarily stopped
- `completed`: Finished delivering
- `failed`: Error state

### 4. Delivery Reporting (`get_media_buy_delivery`)
Retrieves performance metrics for a date range.

**Metrics Returned:**
- Total impressions delivered
- Total spend
- Clicks (where applicable)
- Video completions (where applicable)
- Package-level breakdown

### 5. Performance Optimization (`update_media_buy_performance_index`)
Updates performance indices for AI-driven optimization.

**Performance Index:**
- `1.0`: Baseline performance
- `> 1.0`: Above average (e.g., 1.2 = 20% better)
- `< 1.0`: Below average (e.g., 0.8 = 20% worse)

### 6. Media Buy Updates

The update tools provide a unified interface that mirrors the create_media_buy structure for consistency.

#### `update_media_buy`

Comprehensive tool for campaign and package updates in a single call.

**Campaign-Level Updates:**
- `active`: Pause/resume entire campaign
- `total_budget`: Adjust overall budget
- `flight_end_date`: Extend or shorten campaign
- `targeting_overlay`: Update global targeting
- `pacing`: Change delivery strategy
- `daily_budget`: Set daily spend caps

**Package-Level Updates:**
- Apply different changes to multiple packages in one call
- Each package can have different update parameters

**Platform Implementation:**
- **GAM**: Maps to Order and LineItem updates
- **Kevel**: Maps to Campaign and Flight updates  
- **Triton**: Maps to Campaign and Flight updates

#### `update_package`

Focused tool for package-specific updates.

**Supported Updates:**
- `active`: Pause/resume individual packages
- `budget`: Update budget (recalculates impressions)
- `impressions`: Set impression goal directly
- `cpm`: Adjust CPM rate
- `daily_budget` / `daily_impressions`: Set daily caps
- `pacing`: Package-specific pacing strategy
- `creative_ids`: Update creative assignments
- `targeting_overlay`: Package-specific targeting refinements

**Key Features:**
- Update multiple packages in one call
- Each package update is processed independently
- Returns immediately on first error
- Supports both budget and direct impression updates

## Example Usage

### Creating a Media Buy
```python
response = await mcp.call_tool(
    "create_media_buy",
    {
        "packages": ["premium_sports", "drive_time_audio"],
        "po_number": "PO-2024-001",
        "total_budget": 50000,
        "targeting_overlay": {
            "geography": ["US-CA", "US-NY"],
            "device_types": ["mobile", "desktop"]
        }
    }
)
# Returns: media_buy_id, status, creative_deadline
```

### Uploading Creatives
```python
response = await mcp.call_tool(
    "add_creative_assets",
    {
        "media_buy_id": "kevel_12345",
        "assets": [
            {
                "creative_id": "banner_001",
                "name": "Spring Campaign Banner",
                "format": "image",
                "media_url": "https://cdn.example.com/banner.jpg",
                "click_url": "https://example.com/landing",
                "package_assignments": ["premium_sports"]
            }
        ]
    }
)
```

### Updating a Media Buy

Using the unified interface:

```python
# Pause entire campaign and update budget
response = await mcp.call_tool(
    "update_media_buy",
    {
        "media_buy_id": "gam_67890",
        "active": false,
        "total_budget": 60000
    }
)

# Update multiple packages at once
response = await mcp.call_tool(
    "update_package",
    {
        "media_buy_id": "gam_67890",
        "packages": [
            {
                "package_id": "premium_sports",
                "active": false,
                "budget": 25000
            },
            {
                "package_id": "entertainment",
                "impressions": 750000,
                "daily_impressions": 50000,
                "pacing": "front_loaded"
            }
        ]
    }
)

# Comprehensive update with campaign and package changes
response = await mcp.call_tool(
    "update_media_buy",
    {
        "media_buy_id": "kevel_12345",
        "flight_end_date": "2024-02-28",
        "daily_budget": 5000,
        "packages": [
            {
                "package_id": "news",
                "budget": 15000,
                "creative_ids": ["banner_v2", "video_v2"]
            }
        ]
    }
)
```

## Platform-Specific Considerations

### Google Ad Manager
- Orders can contain multiple LineItems
- LineItems map 1:1 with packages
- Supports sophisticated targeting and frequency capping
- Requires creative approval process

### Kevel
- Campaigns contain Flights
- Flights map 1:1 with packages
- Real-time decisioning engine
- Supports custom creative templates

### Triton Digital
- Optimized for audio advertising
- Campaigns contain Flights for different dayparts
- Strong station/stream targeting capabilities
- Audio-only creative support

## Error Handling

All update operations return a standardized response:
```python
{
    "status": "accepted" | "failed",
    "implementation_date": "2024-01-20T10:00:00Z",  # When change takes effect
    "reason": "Error description if failed",
    "detail": "Additional context"
}
```

## Best Practices

1. **Budget Management**: When updating budgets, the system automatically recalculates impression goals based on the package's CPM rate.

2. **Pause/Resume**: Use media buy level pause/resume for maintenance or emergency stops. Use package level for optimization.

3. **Performance Optimization**: Regular performance index updates help the AI optimize delivery across packages.

4. **Creative Timing**: Upload creatives before the deadline to ensure smooth campaign launch.

5. **Monitoring**: Regular status checks and delivery reports ensure campaigns stay on track.