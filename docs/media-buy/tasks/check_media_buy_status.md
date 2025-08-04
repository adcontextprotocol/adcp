---
title: check_media_buy_status
sidebar_position: 5
---

# check_media_buy_status

Monitor the current status and delivery progress of a media buy.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `context_id` | string | Yes | Context identifier for session persistence |
| `media_buy_id` | string | Yes | ID of the media buy to check |

## Response Format

```json
{
  "context_id": "string",
  "media_buy_id": "string",
  "status": "string",
  "last_updated": "string",
  "package_statuses": [
    {
      "package_id": "string",
      "status": "string",
      "pacing": "string",
      "delivery_percentage": "number"
    }
  ]
}
```

### Field Descriptions

- **context_id**: Context identifier for session persistence
- **media_buy_id**: The media buy ID from the request
- **status**: Overall media buy status
- **last_updated**: ISO 8601 timestamp of last status update
- **package_statuses**: Array of status information for each package
  - **package_id**: Unique identifier for the package
  - **status**: Package delivery status
  - **pacing**: Pacing status (e.g., `"on_track"`, `"slightly_behind"`, `"ahead"`)
  - **delivery_percentage**: Percentage of impressions delivered (0-100)

## Example

### Request
```json
{
  "context_id": "ctx-media-buy-abc123",  // From previous operations
  "media_buy_id": "gam_1234567890"
}
```

### Response
```json
{
  "context_id": "ctx-media-buy-abc123",  // Server maintains context
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

## Status Values

### Media Buy Status

- `pending_activation`: Awaiting creative assets
- `pending_approval`: Under review by ad server
- `pending_manual`: Awaiting human approval (HITL task)
- `pending_permission`: Awaiting permission grant
- `scheduled`: Approved, waiting for start date
- `active`: Currently delivering
- `paused`: Temporarily stopped
- `completed`: Finished delivering
- `failed`: Error state

### Package Status

- `pending`: Not yet started
- `delivering`: Currently serving impressions
- `paused`: Temporarily stopped at package level
- `completed`: Finished delivery
- `underdelivering`: Significantly behind pacing

### Pacing Status

- `on_track`: Delivering as expected
- `slightly_behind`: 5-10% behind schedule
- `behind`: More than 10% behind schedule
- `slightly_ahead`: 5-10% ahead of schedule
- `ahead`: More than 10% ahead of schedule

## Pending State Handling

Orchestrators MUST NOT treat pending states as errors. These are normal operational states that may persist for hours or days depending on publisher workflows. Use `get_pending_tasks` to monitor HITL tasks.

### HITL Task Monitoring

When a media buy has `pending_manual` status, you can monitor the associated task:

```python
if status_response["status"] == "pending_manual":
    # Extract task ID from previous operation response
    tasks = await mcp.call_tool("get_pending_tasks", {
        "task_type": "manual_approval"
    })
    
    # Find and monitor your specific task
    task = find_task_by_media_buy_id(tasks, media_buy_id)
    print(f"Task status: {task['status']}")
    print(f"Assigned to: {task['assigned_to']}")
```

## Usage Notes

- Use this tool to monitor campaign health and pacing
- Check status regularly to identify delivery issues early
- Package-level status provides granular delivery insights
- Pacing calculations consider time elapsed vs. impressions delivered
- The `last_updated` field indicates data freshness
- Pending states are normal operational states, not errors