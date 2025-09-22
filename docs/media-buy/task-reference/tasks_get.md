---
title: tasks/get
---

# tasks/get

Poll a specific task by ID to check status, progress, and retrieve results when complete. This task enables tracking individual async operations through their lifecycle.

**Response Time**: ~1 second (simple database lookup)

**Request Schema**: [`/schemas/v1/media-buy/tasks-get-request.json`](/schemas/v1/media-buy/tasks-get-request.json)  
**Response Schema**: [`/schemas/v1/media-buy/tasks-get-response.json`](/schemas/v1/media-buy/tasks-get-response.json)

## Overview

The `tasks/get` task provides detailed information about a specific async operation. It's the primary polling mechanism for clients that don't use webhooks, and serves as a backup for webhook-enabled clients to verify task completion.

**Key Features:**
- **Status Polling**: Check current status of submitted/working tasks
- **Progress Tracking**: Monitor completion percentage and current step
- **Result Retrieval**: Get full task results when operations complete
- **Error Details**: Access detailed error information for failed tasks
- **History Tracking**: View complete status change timeline (optional)
- **Context Information**: Access task context for identification

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `adcp_version` | string | No | AdCP schema version (default: "1.6.0") |
| `task_id` | string | Yes | Unique identifier of the task to retrieve |
| `include_result` | boolean | No | Include full task result for completed tasks (default: false) |
| `include_history` | boolean | No | Include status change history (default: false) |

## Response Structure

### Basic Task Information

```json
{
  "adcp_version": "1.6.0",
  "message": "Media buy creation is 75% complete. Currently validating inventory availability.",
  "context_id": "ctx-123",
  "task_id": "task_456",
  "task_type": "create_media_buy",
  "status": "working",
  "created_at": "2025-01-22T10:00:00Z",
  "updated_at": "2025-01-22T10:15:00Z",
  "estimated_completion_time": "2025-01-22T10:30:00Z"
}
```

### Task Context

```json
{
  "context": {
    "buyer_ref": "nike_q1_2025",
    "media_buy_id": null,  // Not yet created
    "package_ids": [],
    "creative_count": 0
  },
  "has_webhook": true
}
```

### Progress Information (for working tasks)

```json
{
  "progress": {
    "percentage": 75,
    "current_step": "validating_inventory_availability", 
    "total_steps": 4,
    "step_number": 3
  }
}
```

### Completed Task with Results

```json
{
  "status": "completed",
  "completed_at": "2025-01-22T10:25:00Z",
  "result": {
    "media_buy_id": "mb_987654321",
    "buyer_ref": "nike_q1_2025",
    "packages": [
      {
        "package_id": "pkg_abc123",
        "buyer_ref": "nike_ctv_sports_package"
      }
    ],
    "creative_deadline": "2025-01-29T23:59:59Z"
  }
}
```

### Failed Task with Error Details

```json
{
  "status": "failed",
  "completed_at": "2025-01-22T10:20:00Z",
  "error": {
    "code": "insufficient_inventory",
    "message": "Requested targeting yielded 0 available impressions",
    "details": {
      "requested_budget": 150000,
      "available_impressions": 0,
      "affected_package": "nike_ctv_sports_package"
    }
  }
}
```

### Status History (if requested)

```json
{
  "history": [
    {
      "timestamp": "2025-01-22T10:00:00Z",
      "status": "submitted",
      "message": "Task queued for processing"
    },
    {
      "timestamp": "2025-01-22T10:05:00Z", 
      "status": "working",
      "message": "Started media buy creation",
      "details": {
        "step": "validation_started"
      }
    },
    {
      "timestamp": "2025-01-22T10:15:00Z",
      "status": "working", 
      "message": "Validating inventory availability",
      "details": {
        "step": "inventory_validation",
        "progress": 75
      }
    }
  ]
}
```

## Status Meanings

### submitted
- **Definition**: Task accepted, queued for execution (hours to days)
- **Client Action**: Continue polling or wait for webhook
- **Expected Fields**: `task_id`, `estimated_completion_time`

### working
- **Definition**: Actively processing, expect completion within 120 seconds
- **Client Action**: Poll frequently (every 5-10 seconds) 
- **Expected Fields**: `progress` (optional), current status message

### input-required
- **Definition**: Paused, waiting for user input (approval, clarification)
- **Client Action**: Read message, provide input via context continuation
- **Expected Fields**: Human-readable explanation in `message`

### completed
- **Definition**: Task finished successfully
- **Client Action**: Process results, stop polling
- **Expected Fields**: `completed_at`, `result` (if include_result=true)

### failed
- **Definition**: Task failed due to error
- **Client Action**: Handle error, potentially retry
- **Expected Fields**: `completed_at`, `error` with code and details

## Common Polling Patterns

### Basic Polling Loop

```javascript
async function pollTask(taskId) {
  while (true) {
    const response = await session.call('tasks/get', { 
      task_id: taskId,
      include_result: true 
    });
    
    switch (response.status) {
      case 'completed':
        return response.result;
        
      case 'failed':
        throw new Error(`Task failed: ${response.error.message}`);
        
      case 'input-required':
        const input = await promptUser(response.message);
        // Continue conversation with same context_id
        return session.call('create_media_buy', { 
          context_id: response.context_id,
          additional_info: input 
        });
        
      case 'working':
        console.log(`Progress: ${response.progress?.percentage || 0}%`);
        await sleep(5000); // Poll working tasks frequently
        break;
        
      case 'submitted':
        console.log(`Task queued, ETA: ${response.estimated_completion_time}`);
        await sleep(60000); // Poll submitted tasks less frequently
        break;
    }
  }
}
```

### Smart Polling with Exponential Backoff

```javascript
async function smartPollTask(taskId) {
  let pollInterval = 2000; // Start with 2 seconds
  const maxInterval = 60000; // Max 1 minute
  
  while (true) {
    const response = await session.call('tasks/get', { task_id: taskId });
    
    if (['completed', 'failed'].includes(response.status)) {
      return response;
    }
    
    if (response.status === 'working') {
      pollInterval = 5000; // Reset to frequent polling for active tasks
    } else {
      pollInterval = Math.min(pollInterval * 1.5, maxInterval); // Backoff for submitted
    }
    
    await sleep(pollInterval);
  }
}
```

## Protocol-Specific Examples

### MCP Request
```json
{
  "tool": "tasks/get",
  "arguments": {
    "task_id": "task_456",
    "include_result": true
  }
}
```

### MCP Response  
```json
{
  "message": "Media buy successfully created with 2 packages",
  "context_id": "ctx-456",
  "task_id": "task_456",
  "task_type": "create_media_buy",
  "status": "completed",
  "completed_at": "2025-01-22T10:25:00Z",
  "result": {
    "media_buy_id": "mb_987654321",
    "packages": [...]
  }
}
```

### A2A Request

#### Natural Language Invocation
```javascript
await a2a.send({
  message: {
    parts: [{
      kind: "text", 
      text: "Check the status of task task_456"
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
        skill: "tasks/get",
        parameters: {
          task_id: "task_456",
          include_result: true,
          include_history: true
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
  "taskId": "task-get-001",
  "artifacts": [{
    "name": "task_status_result", 
    "parts": [
      {
        "kind": "text",
        "text": "Media buy successfully created with 2 packages"
      },
      {
        "kind": "data",
        "data": {
          "task_id": "task_456",
          "status": "completed",
          "result": {...}
        }
      }
    ]
  }]
}
```

## Error Handling

### Task Not Found
```json
{
  "status": "failed",
  "message": "Task not found or access denied",
  "errors": [{
    "code": "task_not_found",
    "message": "No task found with ID 'task_456' for this account"
  }]
}
```

### Invalid Task ID Format
```json
{
  "status": "failed", 
  "message": "Invalid task ID format",
  "errors": [{
    "code": "invalid_task_id",
    "message": "Task ID must be a non-empty string",
    "field": "task_id"
  }]
}
```

## Best Practices

### Polling Strategy
- **Frequent polling** for `working` status (5-10 seconds)
- **Infrequent polling** for `submitted` status (30-60 seconds)
- **Exponential backoff** to reduce server load
- **Stop polling** on `completed`, `failed`, or `canceled`

### Result Handling
- Use `include_result: false` for status checks to reduce bandwidth
- Only set `include_result: true` when you need the actual task output
- Cache completed results to avoid repeated polling

### Error Recovery
- Implement retry logic for transient network errors
- Don't retry `failed` status - handle the error appropriately
- Use `include_history: true` for debugging stuck or failed tasks

### Integration Patterns
- Store task IDs with your application entities for later polling
- Use webhook notifications as primary mechanism, polling as backup
- Implement timeout logic based on `estimated_completion_time`

## Related Tasks

- **[`tasks/list`](./tasks_list)** - List tasks to discover task IDs for polling
- **[`create_media_buy`](./create_media_buy)** - Returns task IDs for polling
- **[`update_media_buy`](./update_media_buy)** - Returns task IDs for polling  
- **[`sync_creatives`](./sync_creatives)** - Returns task IDs for polling