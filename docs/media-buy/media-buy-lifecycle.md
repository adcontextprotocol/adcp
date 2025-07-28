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

**Response States:**
- `pending_activation`: Created and awaiting creative assets
- `pending_manual`: Requires human approval before creation
- `pending_permission`: Requires permission grant or manual intervention
- `failed`: Creation failed with error details

**Asynchronous Behavior:**
Orchestrators MUST handle pending states as normal operation flow. Publishers may require manual approval for all operations, resulting in `pending_manual` status with a task ID. The orchestrator should:
1. Store the task ID for tracking
2. Poll `get_pending_tasks` or receive webhook notifications
3. Handle eventual completion or rejection

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
- `pending_approval`: Under review by ad server
- `pending_manual`: Awaiting human approval (HITL task)
- `pending_permission`: Awaiting permission grant
- `active`: Currently delivering
- `paused`: Temporarily stopped
- `completed`: Finished delivering
- `failed`: Error state

**Pending State Handling:**
Orchestrators MUST NOT treat pending states as errors. These are normal operational states that may persist for hours or days depending on publisher workflows. Use `get_pending_tasks` to monitor HITL tasks.

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
    "status": "accepted" | "failed" | "pending_manual" | "pending_permission",
    "implementation_date": "2024-01-20T10:00:00Z",  # When change takes effect
    "reason": "Error description if failed",
    "detail": "Additional context or task ID for pending states"
}
```

### Pending States vs Errors

**Pending States (Normal Flow):**
- `pending_manual`: Operation requires human approval
- `pending_permission`: Operation blocked by permissions
- `pending_approval`: Awaiting ad server approval

These are NOT errors and should be handled as part of normal operation flow.

**Error States (Exceptional):**
- `failed`: Operation cannot be completed
- `AUTHENTICATION_REQUIRED`: Missing or invalid auth
- `INVALID_PARAMETER`: Bad request data
- `NOT_FOUND`: Resource doesn't exist

## Asynchronous Operations and HITL

The AdCP:Buy protocol is designed for asynchronous operations as a core principle. Orchestrators MUST handle pending states gracefully.

### Human-in-the-Loop (HITL) Operations

Many publishers require manual approval for automated operations. The protocol supports this through the HITL task queue:

1. **Operation Request**: Orchestrator calls `create_media_buy` or `update_media_buy`
2. **Pending Response**: Server returns `pending_manual` status with task ID
3. **Task Monitoring**: Orchestrator polls `get_pending_tasks` or receives webhooks
4. **Human Review**: Publisher reviews and approves/rejects via admin interface
5. **Completion**: Original operation executes upon approval

### HITL Task States

```
pending → assigned → in_progress → completed/failed
                  ↓
              escalated
```

### Orchestrator Requirements

Orchestrators MUST:
1. Handle `pending_manual` and `pending_permission` as normal states
2. Store task IDs for tracking pending operations
3. Implement retry logic with exponential backoff for polling
4. Handle eventual rejection of operations gracefully
5. Support webhook callbacks for real-time updates (recommended)

### Example Pending Operation Flow

```python
# 1. Create media buy
response = await mcp.call_tool("create_media_buy", {...})

if response["status"] == "pending_manual":
    task_id = extract_task_id(response["detail"])
    
    # 2. Poll for completion (or use webhooks)
    while True:
        tasks = await mcp.call_tool("get_pending_tasks", {
            "task_type": "manual_approval"
        })
        
        task = find_task(tasks, task_id)
        if task["status"] == "completed":
            # Operation was approved and executed
            break
        elif task["status"] == "failed":
            # Operation was rejected
            handle_rejection(task)
            break
            
        await sleep(60)  # Poll every minute
```

## Best Practices

1. **Budget Management**: When updating budgets, the system automatically recalculates impression goals based on the package's CPM rate.

2. **Pause/Resume**: Use media buy level pause/resume for maintenance or emergency stops. Use package level for optimization.

3. **Performance Optimization**: Regular performance index updates help the AI optimize delivery across packages.

4. **Creative Timing**: Upload creatives before the deadline to ensure smooth campaign launch.

5. **Monitoring**: Regular status checks and delivery reports ensure campaigns stay on track.

6. **Asynchronous Design**: Design orchestrators to handle long-running operations. Never assume immediate completion.

7. **Task Tracking**: Maintain persistent storage for pending task IDs across orchestrator restarts.

8. **Webhook Integration**: Implement webhook endpoints for real-time task updates to reduce polling overhead.

9. **User Communication**: Clearly communicate pending states to end users with expected resolution times.