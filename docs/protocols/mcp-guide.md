---
sidebar_position: 2
title: MCP Guide  
description: Integrate AdCP with Model Context Protocol (MCP). Transport-specific guide for tool calls, context management, and MCP setup.
keywords: [MCP integration, Model Context Protocol, tool calls, context management, MCP server setup]
---

# MCP Integration Guide

Transport-specific guide for integrating AdCP using the Model Context Protocol. For task handling, status management, and workflow patterns, see [Core Concepts](./core-concepts.md).

## MCP Server Setup

### 1. Install AdCP MCP Server

```bash
npm install -g @adcp/mcp-server
```

### 2. Configure Your MCP Client

```json
{
  "mcpServers": {
    "adcp": {
      "command": "npx",
      "args": ["@adcp/mcp-server"],
      "env": {
        "ADCP_API_KEY": "your-api-key",
        "ADCP_ENDPOINT": "https://api.adcp.example.com"
      }
    }
  }
}
```

### 3. Verify Connection

```javascript
// Test connection
const tools = await mcp.listTools();
console.log(tools.map(t => t.name));
// ["get_products", "create_media_buy", "sync_creatives", ...]
```

## Tool Call Patterns

### Basic Tool Invocation

```javascript
// Standard MCP tool call
const response = await mcp.call('get_products', {
  brief: "Video campaign for pet owners",
  promoted_offering: "Premium dog food"
});

// All responses include status field (AdCP 1.6.0+)
console.log(response.status);   // "completed" | "input-required" | "working" | etc.
console.log(response.message);  // Human-readable summary
```

### Tool Call with Filters

```javascript
// Structured parameters
const response = await mcp.call('get_products', {
  filters: {
    format_types: ["video"],
    delivery_type: "guaranteed", 
    max_cpm: 50
  },
  promoted_offering: "Sports betting app"
});
```

## MCP Response Format

**New in AdCP 1.6.0**: All responses include unified status field.

```json
{
  "status": "completed",           // Unified status (see Core Concepts)
  "message": "Found 5 products",  // Human-readable summary  
  "context_id": "ctx-abc123",     // MCP session continuity
  "data": {                       // Task-specific structured data
    "products": [...],
    "errors": [...]               // Task-level errors/warnings
  }
}
```

### MCP-Specific Fields
- **context_id**: Session identifier that you must manually manage
- **data**: Direct JSON structure (vs. A2A's artifact parts)
- **status**: Same values as A2A protocol for consistency

**Status Handling**: See [Core Concepts](./core-concepts.md) for complete status handling patterns.

## Available Tools

All AdCP tasks are available as MCP tools:

### Media Buy Tools
```javascript
await mcp.call('get_products', {...});           // Discover inventory
await mcp.call('list_creative_formats', {...});  // Get format specs
await mcp.call('create_media_buy', {...});       // Create campaigns  
await mcp.call('update_media_buy', {...});       // Modify campaigns
await mcp.call('sync_creatives', {...});         // Manage creative assets
await mcp.call('get_media_buy_delivery', {...}); // Performance metrics
await mcp.call('list_authorized_properties', {...}); // Available properties
await mcp.call('provide_performance_feedback', {...}); // Share outcomes
```

### Signals Tools
```javascript
await mcp.call('get_signals', {...});      // Discover audience signals
await mcp.call('activate_signal', {...});  // Deploy signals to platforms
```

**Task Parameters**: See individual task documentation in [Media Buy](../media-buy/overview.md) and [Signals](../signals/overview.md) sections.

## Context Management (MCP-Specific)

**Critical**: MCP requires manual context management. You must pass `context_id` to maintain conversation state.

### Context Session Pattern

```javascript
class McpAdcpSession {
  constructor(mcpClient) {
    this.mcp = mcpClient;
    this.contextId = null;
  }
  
  async call(tool, params) {
    // Include context from previous calls
    if (this.contextId) {
      params.context_id = this.contextId;
    }
    
    const response = await this.mcp.call(tool, params);
    
    // Save context for next call
    this.contextId = response.context_id;
    
    return response;
  }
  
  reset() {
    this.contextId = null;
  }
}
```

### Usage Example

```javascript
const session = new McpAdcpSession(mcp);

// First call - no context needed
const products = await session.call('get_products', {
  brief: "Sports campaign"
});

// Follow-up - context automatically included
const refined = await session.call('get_products', {
  brief: "Focus on premium CTV"
});
// Session remembers previous interaction
```

### Context Expiration Handling

```javascript
async function handleContextExpiration(session, tool, params) {
  try {
    return await session.call(tool, params);
  } catch (error) {
    if (error.message?.includes('context not found')) {
      // Context expired - start fresh
      session.reset();
      return session.call(tool, params);
    }
    throw error;
  }
}
```

**Key Difference**: Unlike A2A which manages context automatically, MCP requires explicit context_id management.

## Async Operations (MCP-Specific)

MCP handles long-running operations through polling with `context_id`:

### Polling Pattern

```javascript
async function waitForCompletion(session, initialResponse) {
  let response = initialResponse;
  
  // Poll while status is 'working' or 'submitted'
  while (['working', 'submitted'].includes(response.status)) {
    // Wait before polling again  
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Poll for updates using context_id
    response = await session.call('get_products', {
      // Empty params - just checking status with context
    });
  }
  
  return response;
}
```

### Async Operation Example

```javascript
// Start async operation
const initial = await session.call('create_media_buy', {
  packages: ["pkg_001"],
  total_budget: 100000
});

if (initial.status === 'working') {
  // Wait for completion
  const final = await waitForCompletion(session, initial);
  
  if (final.status === 'completed') {
    console.log('Created:', final.data.media_buy_id);
  }
}
```

**Note**: No separate `get_task_status` tool needed - use context_id with any tool to check status.

## Integration Example

```javascript
// Initialize MCP session with context management
const session = new McpAdcpSession(mcp);

// Use unified status handling (see Core Concepts)
async function handleAdcpCall(tool, params) {
  const response = await session.call(tool, params);
  
  switch (response.status) {
    case 'input-required':
      // Handle clarification (see Core Concepts for patterns)
      const input = await promptUser(response.message);
      return session.call(tool, { ...params, additional_info: input });
      
    case 'working':
      // Handle async operations 
      return waitForCompletion(session, response);
      
    case 'completed':
      return response.data;
      
    case 'failed':
      throw new Error(response.message);
  }
}

// Example usage
const products = await handleAdcpCall('get_products', {
  brief: "CTV campaign for luxury cars"
});
```

## MCP-Specific Considerations

### Tool Discovery
```javascript
// List available AdCP tools
const tools = await mcp.listTools();
const adcpTools = tools.filter(t => t.name.startsWith('adcp_') || 
  ['get_products', 'create_media_buy'].includes(t.name));
```

### Parameter Validation
```javascript
// MCP provides tool schemas for validation
const toolSchema = await mcp.getToolSchema('get_products');
// Use schema to validate parameters before calling
```

### Error Handling
```javascript
try {
  const response = await session.call('get_products', params);
} catch (mcpError) {
  // MCP transport errors (connection, auth, etc.)
  console.error('MCP Error:', mcpError);
} 

// AdCP task errors come in response.status === 'failed'
```

## Best Practices

1. **Use session wrapper** for automatic context management
2. **Check status field** before processing response data  
3. **Handle context expiration** gracefully with retries
4. **Reference Core Concepts** for status handling patterns
5. **Validate parameters** using MCP tool schemas when available

## Next Steps

- **Core Concepts**: Read [Core Concepts](./core-concepts.md) for status handling and workflows
- **Task Reference**: See [Media Buy Tasks](../media-buy/overview.md) and [Signals](../signals/overview.md)
- **Protocol Comparison**: Compare with [A2A integration](./a2a-guide.md)
- **Examples**: Find complete workflow examples in Core Concepts

**For status handling, async operations, and clarification patterns, see [Core Concepts](./core-concepts.md) - this guide focuses on MCP transport specifics only.**