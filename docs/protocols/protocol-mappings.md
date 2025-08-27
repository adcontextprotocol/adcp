---
sidebar_position: 5
title: Protocol Mappings
---

# Protocol Mappings

## Overview

AdCP operations map to different protocol transports (MCP, A2A, HTTP) with consistent semantics. Each protocol adapter handles the mapping between AdCP's unified model and protocol-specific requirements.

## Operation Types

AdCP defines three operation types based on execution characteristics:

### Synchronous Operations
Return immediately (typically < 1 second):
- `get_products`
- `list_creative_formats`
- `get_capabilities`
- `get_targeting_capabilities`
- `get_creatives`
- `get_messages` (A2A)

### Asynchronous Operations
Long-running operations that return task/job IDs:
- `create_media_buy`
- `update_media_buy`
- `add_creative_assets`
- `update_package`

### Adaptive Operations
Can be either sync or async based on parameters:
- `get_media_buy_delivery` - Async for large date ranges
- `get_all_media_buy_delivery` - Async for many media buys
- `get_products` - Async for complex natural language queries

## Protocol-Specific Mappings

### MCP (Model Context Protocol)

MCP naturally supports both sync and async patterns:

```json
// Synchronous response
{
  "result": {
    "message": "Found 5 products",
    "products": [...],
    "context_id": "ctx-123"
  }
}

// Asynchronous response
{
  "result": {
    "task_id": "task-456",
    "status": "pending",
    "message": "Creating media buy...",
    "context_id": "ctx-123"
  }
}
```

### A2A (Agent-to-Agent)

A2A requires Task wrappers but can optimize for sync operations:

```json
// Synchronous operation (immediate completion)
{
  "task": {
    "task_id": "task-789",
    "status": "completed",
    "result": {
      "products": [...],
      "message": "Found 5 products"
    },
    "completed_at": "2025-01-15T10:00:00Z"
  },
  "contextId": "ctx-123"
}

// Asynchronous operation (pending)
{
  "task": {
    "task_id": "task-abc",
    "status": "pending",
    "estimated_completion": "2025-01-15T10:05:00Z"
  },
  "contextId": "ctx-123"
}
```

**A2A Optimization**: For synchronous operations, return `status: "completed"` immediately with the result, avoiding unnecessary polling.

### HTTP REST

HTTP uses status codes to indicate sync/async:

```http
# Synchronous - 200 OK
GET /api/products
Response: 200 OK
{
  "message": "Found 5 products",
  "products": [...],
  "context_id": "ctx-123"
}

# Asynchronous - 202 Accepted
POST /api/media-buys
Response: 202 Accepted
Location: /api/tasks/task-123
{
  "task_id": "task-123",
  "status": "pending",
  "status_url": "/api/tasks/task-123"
}
```

## Adaptive Operation Logic

Operations adapt based on request parameters:

```javascript
// Example: get_all_media_buy_delivery
function shouldRunAsync(params) {
  const count = params.media_buy_ids?.length || 999;
  const days = calculateDateRange(params.start_date, params.end_date);
  
  // Async if many media buys or long date range
  return count > 10 || days > 30;
}
```

## Implementation Guidelines

### For Protocol Adapters

1. **Check operation type** from the registry
2. **For sync operations**: Return immediately with full result
3. **For async operations**: Return task ID and status endpoint
4. **For adaptive**: Check parameters to determine mode

### For Task Implementations

1. **Respect operation type** - Don't force async on sync operations
2. **Include progress** for long-running operations
3. **Handle timeouts** - Sync operations should timeout quickly
4. **Return consistent format** regardless of protocol

## Progress Reporting

Asynchronous operations should report progress via:

### MCP
Polling endpoint or callback:
```json
{
  "task_id": "task-123",
  "progress": {
    "current": 3,
    "total": 5,
    "percentage": 60,
    "message": "Creating campaign in ad server..."
  }
}
```

### A2A
Server-Sent Events (SSE):
```javascript
event: progress
data: {"percentage": 60, "message": "Creating campaign..."}
```

### HTTP
Status endpoint:
```http
GET /api/tasks/task-123
{
  "status": "processing",
  "progress": 60,
  "message": "Creating campaign..."
}
```

## Error Handling

All protocols use the same error codes, mapped appropriately:

| AdCP Error Code | MCP | A2A Task | HTTP Status |
|----------------|-----|----------|-------------|
| `invalid_parameter` | -32602 | failed | 400 |
| `authentication_failed` | -32001 | failed | 401 |
| `permission_denied` | -32001 | failed | 403 |
| `not_found` | -32601 | failed | 404 |
| `internal_error` | -32603 | failed | 500 |

## Unified Data Model

AdCP maintains consistent data structures across protocols to ensure client compatibility and implementation simplicity.

### Core Response Fields

| Field | MCP Location | A2A Location | Purpose |
|-------|--------------|--------------|---------|
| message | Root level | artifact.parts[text] | Human-readable summary |
| data | Root level | artifact.parts[data] | Structured response |
| context_id | Root level | Task contextId | Session continuity |
| errors | Root level | artifact.parts[data].errors | Non-fatal warnings |

### Ensuring Compatibility

Implementations should:
1. Use the same JSON schema for `data` field across protocols
2. Generate consistent `message` content
3. Maintain context_id format compatibility
4. Apply identical validation rules and error codes

### Example: Same Data, Both Protocols

```javascript
// Underlying data structure (protocol-agnostic)
const responseData = {
  products: [
    {
      product_id: "ctv_premium",
      name: "Premium CTV",
      cpm: 35,
      formats: ["video_16x9"]
    }
  ],
  total: 5,
  filters_applied: {
    format_types: ["video"]
  }
};

const message = "Found 5 video products with CPMs from $15-45";
const contextId = "ctx-123";

// MCP formatting
const mcpResponse = {
  message,
  context_id: contextId,
  data: responseData
};

// A2A formatting  
const a2aResponse = {
  task: { 
    task_id: "task-789", 
    status: "completed" 
  },
  contextId,
  artifacts: [{
    name: "product_catalog",
    parts: [
      { kind: "text", text: message },
      { kind: "data", data: responseData }
    ]
  }]
};
```

### Response Format Mapping

For each AdCP task, the response maps between protocols as follows:

```json
// MCP Task Response
{
  "message": "Human summary",
  "context_id": "ctx-abc",
  "data": { /* Structured data */ },
  "errors": [ /* Warnings */ ]
}

// A2A Task Response
{
  "task": {
    "task_id": "task-123",
    "status": "completed"
  },
  "contextId": "ctx-abc",
  "artifacts": [{
    "name": "task_result",
    "parts": [
      { "kind": "text", "text": "Human summary" },
      { 
        "kind": "data", 
        "data": { 
          /* Structured data */,
          "errors": [ /* Warnings */ ]
        } 
      }
    ]
  }]
}
```

## Best Practices

1. **Default to synchronous** unless operation genuinely needs async
2. **Set realistic timeouts** - 5 seconds for sync, configurable for async
3. **Include estimated duration** for async operations
4. **Cache sync results** when appropriate
5. **Document operation type** clearly in API reference
6. **Maintain data consistency** across protocols using shared schemas