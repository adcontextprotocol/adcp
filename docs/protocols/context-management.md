---
sidebar_position: 5
title: Context Management
---

# Context Management

How AdCP handles conversation state differs significantly between protocols.

## Key Difference

- **A2A**: Context is handled automatically by the protocol
- **MCP**: Requires manual context_id management

## A2A Context (Automatic)

A2A handles sessions natively - you don't need to manage context:

```javascript
// A2A maintains context automatically
const task = await a2a.send({ message: {...} });
// contextId is managed by A2A protocol

// Follow-ups automatically use the same context
const followUp = await a2a.send({ 
  contextId: task.contextId,  // Optional - A2A tracks this
  message: {...} 
});
```

The A2A protocol maintains:
- Session state
- Conversation history
- Task relationships
- Context switching

## MCP Context (Manual)

MCP requires explicit context management to maintain state:

```javascript
// First call - no context
const result1 = await mcp.call('get_products', {
  brief: "Video ads"
});
const contextId = result1.context_id;  // Save this!

// Follow-up - must include context_id
const result2 = await mcp.call('get_products', {
  context_id: contextId,  // Required for continuity
  brief: "Focus on premium inventory"
});
```

### MCP Context Management Pattern

```javascript
class MCPSession {
  constructor(mcp) {
    this.mcp = mcp;
    this.contextId = null;
  }
  
  async call(method, params) {
    const result = await this.mcp.call(method, {
      ...params,
      context_id: this.contextId
    });
    this.contextId = result.context_id;  // Update for next call
    return result;
  }
}
```

## What Context Maintains

Regardless of protocol:
- Current media buy and products
- Search results and filters
- Conversation history
- User preferences
- Workflow state

## Best Practices

### For A2A
- Let the protocol handle context
- Use contextId for explicit conversation threading
- Trust the session management

### For MCP
- Always preserve context_id between calls
- Implement a session wrapper (see pattern above)
- Handle context expiration (1 hour timeout)
- Start fresh context for new workflows