---
title: tasks/list
---

# tasks/list

List and filter async tasks across your account to enable state reconciliation and operation tracking. This task provides visibility into all pending, completed, and failed operations.

**Response Time**: ~1 second (simple database lookup)

**Request Schema**: [`/schemas/v1/media-buy/tasks-list-request.json`](/schemas/v1/media-buy/tasks-list-request.json)  
**Response Schema**: [`/schemas/v1/media-buy/tasks-list-response.json`](/schemas/v1/media-buy/tasks-list-response.json)

## Overview

The `tasks/list` task provides comprehensive visibility into async operations across your account. It enables state reconciliation, operation tracking, and recovery from lost or orphaned tasks. This is essential for maintaining sync between client and server state.

**Key Features:**
- **State Reconciliation**: Find all pending tasks to ensure no operations are lost
- **Advanced Filtering**: Filter by status, task type, dates, context, and more
- **Webhook Visibility**: Identify which tasks have webhook configuration
- **Context Search**: Find tasks by buyer reference, media buy ID, or other identifiers
- **Pagination Support**: Handle accounts with many concurrent operations
- **Status Tracking**: Monitor task progression through submitted → working → completed

## Request Parameters

### Core Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `adcp_version` | string | No | AdCP schema version (default: "1.6.0") |
| `filters` | object | No | Filter criteria for querying tasks |
| `sort` | object | No | Sorting parameters |
| `pagination` | object | No | Pagination controls |

### Data Inclusion Options

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `include_context` | boolean | No | Include task context information (default: true) |
| `include_result` | boolean | No | Include full results for completed tasks (default: false) |

## Filtering Options

### Status and Type Filtering

```json
{
  "filters": {
    "status": "submitted",           // Single status
    "statuses": ["submitted", "working", "input-required"],  // Multiple statuses
    "task_type": "create_media_buy", // Single task type
    "task_types": ["create_media_buy", "update_media_buy"]   // Multiple task types
  }
}
```

### Date Range Filtering

```json
{
  "filters": {
    "created_after": "2025-01-01T00:00:00Z",
    "created_before": "2025-01-31T23:59:59Z",
    "updated_after": "2025-01-20T00:00:00Z",
    "updated_before": "2025-01-25T23:59:59Z"
  }
}
```

### Context and ID Filtering

```json
{
  "filters": {
    "task_ids": ["task_456", "task_789"],           // Specific task IDs
    "context_contains": "nike_q1_2025",             // Search in context fields
    "has_webhook": true                             // Filter by webhook presence
  }
}
```

## Response Structure

```json
{
  "adcp_version": "1.6.0",
  "message": "Found 27 tasks matching your criteria. 15 are pending and may need attention.",
  "context_id": "ctx-123",
  "query_summary": {
    "total_matching": 27,
    "returned": 20,
    "filters_applied": ["status_filter", "date_range"],
    "sort_applied": {
      "field": "created_at",
      "direction": "desc"
    }
  },
  "tasks": [
    {
      "task_id": "task_456",
      "task_type": "create_media_buy",
      "status": "submitted",
      "created_at": "2025-01-22T10:00:00Z",
      "updated_at": "2025-01-22T10:00:00Z", 
      "estimated_completion_time": "2025-01-23T10:00:00Z",
      "message": "Media buy requires manual approval for $150K campaign",
      "context": {
        "buyer_ref": "nike_q1_2025",
        "media_buy_id": null
      },
      "has_webhook": true
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "has_more": true,
    "next_offset": 20
  }
}
```

## Common Use Cases

### State Reconciliation

Find all pending operations to ensure nothing is lost:

```json
{
  "filters": {
    "statuses": ["submitted", "working", "input-required"]
  },
  "sort": {
    "field": "created_at",
    "direction": "asc"
  }
}
```

### Find Operations Needing Attention

Identify tasks that require user input or have failed:

```json
{
  "filters": {
    "statuses": ["input-required", "failed"]
  },
  "sort": {
    "field": "updated_at", 
    "direction": "asc"
  }
}
```

### Campaign-Specific Task Tracking

Find all tasks related to a specific campaign:

```json
{
  "filters": {
    "context_contains": "nike_q1_2025"
  },
  "include_result": true
}
```

### Monitor Recent Activity

Get recent operations across all types:

```json
{
  "filters": {
    "created_after": "2025-01-20T00:00:00Z"
  },
  "sort": {
    "field": "created_at",
    "direction": "desc" 
  },
  "pagination": {
    "limit": 50
  }
}
```

## Protocol-Specific Examples

The AdCP payload is identical across protocols. Only the request/response wrapper differs.

### MCP Request
```json
{
  "tool": "tasks/list",
  "arguments": {
    "filters": {
      "statuses": ["submitted", "working"]
    }
  }
}
```

### MCP Response
```json
{
  "message": "Found 5 pending tasks",
  "context_id": "ctx-tasks-123",
  "query_summary": {
    "total_matching": 5,
    "returned": 5
  },
  "tasks": [...]
}
```

### A2A Request

#### Natural Language Invocation
```javascript
await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "Show me all pending tasks from the last week"
    }]
  }
});
```

#### Explicit Skill Invocation
```javascript
await a2a.send({
  message: {
    parts: [{
      kind: "data",
      data: {
        skill: "tasks/list",
        parameters: {
          filters: {
            statuses: ["submitted", "working", "input-required"],
            created_after: "2025-01-15T00:00:00Z"
          }
        }
      }
    }]
  }
});
```

### A2A Response
```json
{
  "status": "completed",
  "taskId": "task-list-001", 
  "artifacts": [{
    "name": "task_list_results",
    "parts": [
      {
        "kind": "text",
        "text": "Found 5 pending tasks"
      },
      {
        "kind": "data",
        "data": {
          "query_summary": {...},
          "tasks": [...]
        }
      }
    ]
  }]
}
```

## Error Handling

### Common Error Scenarios

1. **Invalid Date Range**: `created_after` is later than `created_before`
2. **Pagination Limits**: Offset exceeds available results
3. **Invalid Task Types**: Unknown task type in filter
4. **Permission Issues**: Tasks filtered by account access

### Error Response Format

```json
{
  "status": "failed",
  "message": "Invalid date range: created_after must be before created_before",
  "context_id": "ctx-123",
  "errors": [{
    "code": "invalid_date_range",
    "message": "created_after (2025-01-25) is after created_before (2025-01-20)",
    "field": "filters.created_after"
  }]
}
```

## Best Practices

### State Reconciliation
- Run `tasks/list` with pending status filters during application startup
- Include webhook status to identify tasks that may send future notifications
- Use context search to link tasks to your application's operations

### Performance Optimization  
- Use pagination for accounts with many operations
- Filter by date ranges to limit results to relevant time periods
- Use `include_result: false` unless you need full task results

### Monitoring and Alerting
- Check for old tasks in `submitted` status that may be stuck
- Monitor `input-required` tasks that need user attention
- Track `failed` tasks for error reporting and retry logic

## Related Tasks

- **[`tasks/get`](./tasks_get)** - Poll specific task for detailed status and results
- **[`create_media_buy`](./create_media_buy)** - Creates tasks that appear in this list
- **[`update_media_buy`](./update_media_buy)** - Creates tasks that appear in this list
- **[`sync_creatives`](./sync_creatives)** - Creates tasks that appear in this list