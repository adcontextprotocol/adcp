---
sidebar_position: 4
title: Protocol Comparison
---

# Protocol Comparison

Both MCP and A2A provide full access to all AdCP capabilities. They differ only in how they structure requests and responses.

## Quick Comparison

| Aspect | MCP | A2A |
|--------|-----|-----|
| **Request Style** | Tool calls | Task messages |
| **Response Style** | Direct JSON | Artifacts |
| **Async Handling** | Polling | SSE streaming |
| **Context** | Manual (pass context_id) | Automatic (protocol-managed) |
| **Best For** | Claude, AI assistants | Agent workflows |

## Same Data, Different Structure

Both protocols deliver identical data, just formatted differently:

### MCP Format
```json
{
  "message": "Found 5 products",
  "context_id": "ctx-123",
  "data": {
    "products": [...],
    "total": 5
  }
}
```

### A2A Format
```json
{
  "contextId": "ctx-123",
  "artifacts": [{
    "name": "product_catalog",
    "parts": [
      {"kind": "text", "text": "Found 5 products"},
      {"kind": "data", "data": {"products": [...], "total": 5}}
    ]
  }]
}
```

## Key Differences

### Synchronous Operations
- **MCP**: Returns data directly
- **A2A**: Returns completed task with artifacts

### Asynchronous Operations  
- **MCP**: Returns task_id, client polls for status
- **A2A**: Streams updates via SSE

### Clarifications
- **MCP**: Sets `clarification_needed: true` in data
- **A2A**: Uses message field for questions

### Multi-Part Responses
- **MCP**: All data in single response object
- **A2A**: Can split across multiple artifact parts (JSON + PDF)

## Operation Type Mapping

| Operation | Type | MCP Response | A2A Response |
|-----------|------|--------------|--------------|
| get_products | Sync | Direct data | Immediate artifacts |
| create_media_buy | Async | Task ID | SSE updates |
| sync_creatives | Async | Task ID | SSE updates |

## Choosing Between Protocols

Choose based on your client ecosystem:
- **MCP**: If using Claude or MCP-compatible tools
- **A2A**: If using Google agents or A2A-compatible systems

Both support all AdCP features - clarifications, approvals, async operations, and complete functionality.