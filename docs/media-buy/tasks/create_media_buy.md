---
title: create_media_buy
sidebar_position: 3
---

# create_media_buy

Create a media buy from selected packages. This task handles the complete workflow including validation, approval if needed, and campaign creation.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `context_id` | string | No | Context identifier for session persistence |
| `packages` | string[] | Yes | Array of package IDs to include in the media buy |
| `po_number` | string | Yes | Purchase order number for tracking |
| `total_budget` | number | Yes | Total budget in USD |
| `targeting_overlay` | object | No | Additional targeting criteria to apply across all packages |
| `targeting_overlay.geo_country_any_of` | string[] | No | Target specific countries (ISO codes) |
| `targeting_overlay.geo_region_any_of` | string[] | No | Target specific regions/states |
| `targeting_overlay.audience_segment_any_of` | string[] | No | Target specific audience segments |
| `targeting_overlay.signals` | string[] | No | Signal IDs from get_signals |
| `targeting_overlay.frequency_cap` | object | No | Frequency capping settings |
| `targeting_overlay.frequency_cap.suppress_minutes` | number | No | Minutes to suppress after impression |
| `targeting_overlay.frequency_cap.scope` | string | No | Apply at `"media_buy"` or `"package"` level |
| `pacing` | string | No | Pacing strategy: `"even"`, `"asap"`, or `"front_loaded"` |
| `daily_budget` | number | No | Daily budget cap in USD (null for no limit) |

## Response Format

```json
{
  "context_id": "string",
  "media_buy_id": "string",
  "status": "string",
  "creative_deadline": "string",
  "detail": "string",
  "next_steps": ["string"]
}
```

### Field Descriptions

- **context_id**: Context identifier for session persistence
- **media_buy_id**: Unique identifier for the created media buy
- **status**: Current status (e.g., `"pending_activation"`, `"active"`)
- **creative_deadline**: ISO 8601 timestamp for creative upload deadline
- **detail**: Human-readable description of what was created
- **next_steps**: Array of recommended actions to complete the media buy

## Example

### Request
```json
{
  "context_id": "ctx-media-buy-abc123",  // From product discovery
  "packages": ["pkg_ctv_prime_ca_ny", "pkg_audio_drive_ca_ny"],
  "po_number": "PO-2024-Q1-0123",
  "total_budget": 50000,
  "targeting_overlay": {
    "geo_country_any_of": ["US"],
    "geo_region_any_of": ["CA", "NY"],
    "audience_segment_any_of": ["3p:pet_owners"],
    "signals": ["auto_intenders_q1_2025"],
    "frequency_cap": {
      "suppress_minutes": 30,
      "scope": "media_buy"
    }
  },
  "pacing": "even",
  "daily_budget": null
}
```

### Response
```json
{
  "context_id": "ctx-media-buy-abc123",  // Server maintains context
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

## Platform Behavior

Different advertising platforms handle media buy creation differently:

- **Google Ad Manager (GAM)**: Creates Order with LineItems, requires approval
- **Kevel**: Creates Campaign with Flights, instant activation
- **Triton**: Creates Campaign for audio delivery

## Status Values

The media buy can have the following status values:

- `pending_activation`: Awaiting creative assets
- `pending_approval`: Under platform review
- `pending_manual`: Awaiting human approval (HITL)
- `pending_permission`: Blocked by permissions
- `scheduled`: Future start date
- `active`: Currently delivering
- `paused`: Temporarily stopped
- `completed`: Finished delivering
- `failed`: Error state

## Asynchronous Behavior

Orchestrators MUST handle pending states as normal operation flow. Publishers may require manual approval for all operations, resulting in `pending_manual` status with a task ID. The orchestrator should:

1. Store the task ID for tracking
2. Poll `get_pending_tasks` or receive webhook notifications
3. Handle eventual completion or rejection

### Example Pending Operation Flow

```python
# 1. Create media buy
response = await mcp.call_tool("create_media_buy", {
    "packages": ["premium_sports", "drive_time_audio"],
    "po_number": "PO-2024-001",
    "total_budget": 50000,
    "targeting_overlay": {
        "geography": ["US-CA", "US-NY"],
        "device_types": ["mobile", "desktop"]
    }
})

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

## Platform Mapping

How media buy creation maps to different platforms:

- **Google Ad Manager**: Creates an Order with LineItems
- **Kevel**: Creates a Campaign with Flights
- **Triton Digital**: Creates a Campaign with Flights

## Usage Notes

- A media buy represents a complete advertising campaign with one or more packages
- Targeting overlay applies additional criteria on top of package-level targeting
- The total budget is distributed across packages based on their individual settings
- Creative assets must be uploaded before the deadline for the campaign to activate
- Pending states are normal operational states, not errors
- Orchestrators MUST NOT treat pending states as errors - they are part of normal workflow