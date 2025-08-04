---
sidebar_position: 4
title: Context Management
---

# Context Management Across Protocols

AdCP uses a unified context management approach that works consistently across all protocols.

## The Context ID

Every AdCP task supports a `context_id` parameter that:
- Is optional on the first request (blank/null)
- Is created by the server on first response
- Should be included in all subsequent related requests
- Maintains conversation state and task relationships

## How It Works

### First Request (No Context)
```json
// MCP
{
  "tool": "create_media_buy",
  "arguments": {
    "context_id": null,  // or omitted
    "packages": ["pkg_123"],
    "total_budget": 50000
  }
}

// A2A
{
  "method": "message/send",
  "params": {
    "contextId": null,  // or omitted
    "message": {
      "parts": [{
        "kind": "text",
        "text": "Create a $50K campaign"
      }]
    }
  }
}
```

### First Response (Context Created)
```json
// MCP
{
  "context_id": "ctx-campaign-abc123",  // Server creates this
  "media_buy_id": "mb_789",
  "status": "pending_creatives"
}

// A2A
{
  "contextId": "ctx-campaign-abc123",  // Same context!
  "taskId": "task-mb-001",
  "status": { "state": "pending_creatives" }
}
```

### Subsequent Requests (With Context)
```json
// MCP
{
  "tool": "add_creative_assets",
  "arguments": {
    "context_id": "ctx-campaign-abc123",  // Include context
    "media_buy_id": "mb_789",
    "assets": [...]
  }
}

// A2A  
{
  "contextId": "ctx-campaign-abc123",  // Same context
  "message": {
    "parts": [{
      "kind": "text",
      "text": "Add our hero creative"
    }]
  }
}
```

## Benefits for Task Authors

With unified context management, task implementations can:

```javascript
class MediaBuyTask {
  async execute(input, ctx) {
    // Get or create context
    const contextId = input.context_id || ctx.createContextId();
    
    // Store state that works across protocols
    await ctx.setState(contextId, {
      campaign: { budget, packages },
      step: 'created',
      history: []
    });
    
    // Return context for future use
    return {
      context_id: contextId,  // MCP field
      contextId: contextId,   // A2A field (both for compatibility)
      media_buy_id: mediaBuyId
    };
  }
}
```

## Protocol-Specific Mapping

### MCP
- Uses `context_id` parameter in all requests/responses
- Context persists across tool calls
- Enables multi-step workflows

### A2A
- Uses native `contextId` field
- Already supports conversation context
- Maps directly to our unified context

### REST (Future)
- Will use `context_id` in request body
- Returns in response headers or body
- Maintains same semantics

## Use Cases

### 1. Multi-Step Campaign Creation
```javascript
// Step 1: Create campaign (no context)
{ context_id: null, ... }
// Response: context_id: "ctx-123"

// Step 2: Add creatives (with context)
{ context_id: "ctx-123", ... }

// Step 3: Request changes (same context)
{ context_id: "ctx-123", ... }
```

### 2. Approval Workflows
```javascript
// Create with approval needed
{ context_id: null, ... }
// Response: context_id: "ctx-456", status: "pending_approval"

// Approver continues in same context
{ context_id: "ctx-456", approved: true }
```

### 3. Creative Iterations
```javascript
// Upload creative
{ context_id: null, creative: "video.mp4" }
// Response: context_id: "ctx-789"

// Request variations
{ context_id: "ctx-789", variations: ["15s", "vertical"] }

// Review and approve
{ context_id: "ctx-789", approved_ids: [...] }
```

## Implementation Guidelines

### For Protocol Adapters

```javascript
// MCP Adapter
function adaptMCPRequest(tool, args) {
  return {
    context_id: args.context_id || null,
    ...args
  };
}

// A2A Adapter  
function adaptA2ARequest(message) {
  return {
    context_id: message.contextId || null,
    ...parseMessage(message)
  };
}
```

### For Task Implementations

1. **Always check for context**: Use provided context or create new
2. **Persist state**: Store task state keyed by context_id
3. **Return context**: Include in all responses
4. **Handle missing context**: Gracefully handle requests without context

## Best Practices

1. **Context Naming**: Use descriptive prefixes (e.g., `ctx-campaign-`, `ctx-creative-`)
2. **Context Lifetime**: Define clear expiration policies
3. **Context Scope**: Keep contexts focused on related operations
4. **Error Handling**: Provide clear errors for invalid/expired contexts

## Migration Notes

For existing MCP implementations:
1. Add `context_id` to all tool parameters
2. Generate and return context_id in responses
3. Use context for state management
4. No breaking changes - context_id is optional

For A2A implementations:
1. Already have contextId support
2. Ensure consistent context generation
3. Map contextId ↔ context_id for cross-protocol compatibility