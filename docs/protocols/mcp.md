---
sidebar_position: 2
title: MCP Integration
---

# MCP (Model Context Protocol) Integration

AdCP's MCP integration provides a direct interface for AI assistants to interact with advertising platforms.

## Overview

MCP is Anthropic's protocol designed for AI-to-application communication. In AdCP, MCP exposes tasks as tools that AI assistants can call directly.

## How Tasks Map to MCP Tools

Each AdCP task becomes an MCP tool:

```javascript
// AdCP Task
create_media_buy

// MCP Tool Definition
{
  "name": "create_media_buy",
  "description": "Create a media buy from selected packages",
  "parameters": {
    "type": "object",
    "properties": {
      "packages": { "type": "array" },
      "total_budget": { "type": "number" },
      "targeting_overlay": { "type": "object" }
    }
  }
}
```

## Synchronous vs Asynchronous Operations

### Synchronous Operations
Quick tasks return immediately:

```json
// Request
{
  "tool": "get_products",
  "arguments": {
    "brief": "Premium video inventory"
  }
}

// Response (immediate)
{
  "products": [...]
}
```

### Asynchronous Operations
Long-running tasks return a task ID for polling:

```json
// Request
{
  "tool": "create_media_buy",
  "arguments": {
    "packages": ["pkg_123"],
    "total_budget": 50000
  }
}

// Response (immediate)
{
  "task_id": "task_456",
  "status": "pending",
  "poll_url": "/tasks/task_456"
}
```

## Handling Human-in-the-Loop

When human approval is required, MCP returns an error with task information:

```json
{
  "error": {
    "code": "PENDING_APPROVAL",
    "message": "Campaign requires compliance approval",
    "task_id": "task_789",
    "poll_url": "/tasks/task_789"
  }
}
```

Clients must poll or register webhooks to track task completion.

## Example: Media Buy Workflow

```javascript
// 1. Discover products
const products = await mcp.call('get_products', {
  brief: "Sports inventory for Nike",
  filters: { formats: ["video"] }
});

// 2. Create media buy (async)
const result = await mcp.call('create_media_buy', {
  packages: products.slice(0, 3).map(p => p.product_id),
  total_budget: 100000
});

// 3. Handle async response
if (result.task_id) {
  // Poll for completion
  let status;
  do {
    await sleep(5000);
    status = await fetch(result.poll_url);
  } while (status.state === 'pending');
}

// 4. Add creatives
await mcp.call('add_creative_assets', {
  media_buy_id: result.media_buy_id,
  assets: [...]
});
```

## MCP-Specific Considerations

### Error Handling
MCP uses standard error responses:
```json
{
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "Budget must be positive",
    "field": "total_budget"
  }
}
```

### Timeouts
- Default timeout: 30 seconds for synchronous operations
- Async operations return immediately with task ID
- Long polling timeout: 60 seconds

### Authentication
MCP uses header-based authentication:
```
x-adcp-auth: Bearer <token>
```

## Best Practices

1. **Use Async for Long Operations**: Operations that might take >5 seconds should be async
2. **Handle Pending States**: Many operations require approval - handle these gracefully
3. **Batch When Possible**: Use bulk operations to reduce round trips
4. **Check Capabilities First**: Use `list_creative_formats` before uploading creatives

## Limitations

- No built-in streaming for status updates
- Manual context management between calls
- Polling required for async operations
- Custom implementation needed for complex workflows

## Migration from Direct API

If migrating from a REST API:

1. Wrap API calls in MCP tool handlers
2. Convert webhooks to polling or MCP-compatible callbacks
3. Map error codes to MCP error format
4. Add tool descriptions for AI discovery