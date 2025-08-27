---
sidebar_position: 5
title: Context Management
---

# Context Management

AdCP maintains conversation context across multiple interactions, enabling stateful workflows.

## How Context Works

1. **First Request**: Omit context_id or set to null
2. **Response**: Returns a new context_id
3. **Follow-up**: Include context_id to maintain state
4. **Expiration**: Contexts expire after 1 hour of inactivity

## What Context Maintains

- Current media buy and products
- Search results and filters
- Conversation history
- User preferences
- Workflow state

## Protocol Differences

### MCP
```json
// First call
{ "method": "get_products", "params": {...} }
// Response: { "context_id": "ctx-123", ... }

// Follow-up
{ "method": "get_products", "params": { "context_id": "ctx-123", ... } }
```

### A2A
```json
// First call
{ "message": {...} }
// Response: { "contextId": "ctx-123", ... }

// Follow-up automatically uses context
{ "contextId": "ctx-123", "message": {...} }
```

## Best Practices

- **Always preserve context_id** for multi-turn conversations
- **Don't rely on context** for critical data (it expires)
- **Start fresh** when switching workflows
- **Handle expiration** gracefully by starting new context