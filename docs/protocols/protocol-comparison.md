---
sidebar_position: 4
title: Protocol Comparison
description: Compare MCP and A2A protocols for AdCP integration. Both use the same unified status system with different transport formats.
keywords: [MCP vs A2A, protocol comparison, AdCP integration, status handling, transport differences]
---

# Protocol Comparison

Both MCP and A2A provide identical AdCP capabilities using the same unified status system. They differ only in transport format and async handling.

## Quick Comparison

| Aspect | MCP | A2A |
|--------|-----|-----|
| **Request Style** | Tool calls | Task messages |
| **Response Style** | Direct JSON | Artifacts |
| **Status System** | ✅ Unified status field | ✅ Unified status field |
| **Async Handling** | Polling with tasks/get | SSE streaming |
| **Webhooks** | Protocol wrapper extension | Native PushNotificationConfig |
| **Task Management** | tasks/list, tasks/get tools | Native tasks/list, tasks/get |
| **Context** | Manual (pass context_id) | Automatic (protocol-managed) |
| **Best For** | Claude, AI assistants | Agent workflows |

## Unified Status System

**✨ New in AdCP 1.6.0**: Both protocols now use the same status field with A2A TaskState values.

### Status Handling (Both Protocols)

Every response includes a status field that tells you exactly what to do:

```json
{
  "status": "input-required",    // Same values for both protocols
  "message": "Need your budget", // Same human explanation
  // ... protocol-specific formatting below
}
```

| Status | What It Means | Your Action |
|--------|---------------|-------------|
| `completed` | Task finished | Process data, show success |
| `input-required` | Need user input | Read message, prompt user, follow up |
| `working` | Processing (< 120s) | Poll frequently, show progress |
| `submitted` | Long-running (hours to days) | Provide webhook or poll less frequently |
| `failed` | Error occurred | Show error, handle gracefully |
| `auth-required` | Need auth | Prompt for credentials |

See [Core Concepts](./core-concepts.md) for complete status handling guide.

## Transport Format Differences

Same status and data, different packaging:

### MCP Response Format
```json
{
  "message": "I need your budget and target audience",
  "status": "input-required",
  "context_id": "ctx-123",
  "data": {
    "products": [],
    "suggestions": ["budget", "audience"]
  }
}
```

### A2A Response Format
```json
{
  "status": "input-required",
  "contextId": "ctx-123",
  "artifacts": [{
    "name": "product_discovery",
    "parts": [
      {
        "kind": "text", 
        "text": "I need your budget and target audience"
      },
      {
        "kind": "data",
        "data": {
          "products": [],
          "suggestions": ["budget", "audience"]
        }
      }
    ]
  }]
}
```

## Async Operation Differences

Both protocols handle async operations with the same status progression:
`submitted` → `working` → `completed`/`failed`

### MCP Async Pattern
```javascript
// Initial response with task_id
{
  "status": "submitted",
  "message": "Creating media buy, requires manual approval",
  "context_id": "ctx-123",
  "task_id": "task-456",
}

// Poll using tasks/get
const updates = await session.call('tasks/get', { 
  task_id: "task-456", 
  include_result: true 
});

// Optional: Configure webhook at protocol level
const response = await session.call('create_media_buy', params, {
  webhook_config: {
    url: "https://buyer.com/webhooks",
    auth: {
      type: "bearer",
      token: "secret_token_min_32_chars"
    }
  }
});
```

### A2A Async Pattern
```javascript
// Initial response with native task tracking
{
  "status": "submitted", 
  "taskId": "task-456",
  "contextId": "ctx-123",
  "estimatedCompletionTime": "2025-01-23T10:00:00Z"
}

// Real-time updates via SSE
const events = new EventSource(`/tasks/${response.taskId}/events`);
events.onmessage = (event) => {
  const update = JSON.parse(event.data);
  console.log(`Status: ${update.status}, Message: ${update.message}`);
};

// Native webhook support
await a2a.send({
  message: { /* skill invocation */ },
  push_notification_config: {
    webhook_url: "https://buyer.com/webhooks",
    authentication: {
      schemes: ["Bearer"],
      credentials: "secret_token_min_32_chars"
    }
  }
});
```

## Webhook & Task Management Differences

### Webhook Configuration

Both protocols support webhooks but with different implementation approaches:

#### MCP: Protocol Wrapper Extension
```javascript
// Webhook config at protocol level (like context_id)
class McpAdcpSession {
  async call(tool, params, options = {}) {
    const request = { tool, arguments: params };

    if (options.webhook_config) {
      request.webhook_config = {
        url: options.webhook_config.url,
        auth: {
          type: 'bearer',
          token: options.webhook_config.auth.token  // Bearer token (required)
        }
      };
    }

    return await this.mcp.call(request);
  }
}
```

#### A2A: Native Push Notifications  
```javascript
// Built-in PushNotificationConfig
await a2a.send({
  message: { /* task */ },
  push_notification_config: {
    webhook_url: "https://buyer.com/webhooks",
    authentication: {
      schemes: ["Bearer"],
      credentials: "secret_token_min_32_chars"
    },
    events: ["state_change", "completion"]
  }
});
```

### Task Management

Both protocols now provide equivalent task management capabilities:

#### MCP: AdCP Tasks
```javascript
// List pending tasks
await session.call('tasks/list', {
  filters: { statuses: ["submitted", "working"] }
});

// Poll specific task
await session.call('tasks/get', { 
  task_id: "task_456", 
  include_result: true 
});

// State reconciliation
const reconciliation = await session.reconcileState();
```

#### A2A: Native RPC Methods
```javascript
// Native task management
const tasks = await a2a.rpc('tasks/list', {
  filters: { statuses: ["submitted", "working"] }
});

const task = await a2a.rpc('tasks/get', { 
  task_id: "task_456",
  include_result: true 
});
```

### Server Decision Making

In both protocols, the server decides whether to use webhooks:

- **Quick operations** (< 120s): Returns `working`, ignores webhook configuration
- **Long operations** (hours/days): Returns `submitted`, uses webhook if provided
- **Fallback**: Clients can always poll regardless of webhook configuration

## Clarification Handling

**Before AdCP 1.6.0**: Different approaches for each protocol  
**After AdCP 1.6.0**: Same pattern using `status: "input-required"`

### Unified Clarification Pattern

```javascript
// Works for both MCP and A2A
function handleResponse(response) {
  if (response.status === 'input-required') {
    // Extract clarification from message
    const info = promptUser(response.message);
    
    // Send follow-up with same context
    return sendFollowUp(response.context_id, info);
  }
  
  if (response.status === 'completed') {
    return processResults(response.data);
  }
}
```

### Example: Clarification Flow

**User:** "Find video products"  
**AdCP Response:** 
```json
{
  "status": "input-required",
  "message": "I'd be happy to help find video products. What's your budget and target audience?",
  "context_id": "ctx-123"
}
```

**User Follow-up:** "Budget is $50K, targeting pet owners"  
**AdCP Response:**
```json
{
  "status": "completed", 
  "message": "Found 8 video products perfect for pet owners",
  "context_id": "ctx-123",
  "data": { "products": [...] }
}
```

## Human-in-the-Loop Workflows

Both protocols handle approvals using `status: "input-required"`:

```json
{
  "status": "input-required",
  "message": "Media buy exceeds auto-approval limit ($100K). Please approve to proceed.",
  "context_id": "ctx-123",
  "data": {
    "approval_required": true,
    "amount": 150000,
    "reason": "exceeds_limit"
  }
}
```

Client handling is identical:
```javascript
if (response.status === 'input-required' && response.data?.approval_required) {
  const decision = await getApproval(response.message);
  return sendApproval(response.context_id, decision);
}
```

## Context Management

### MCP: Manual Context
```javascript
let contextId = null;

async function callAdcp(request) {
  if (contextId) {
    request.context_id = contextId;
  }
  
  const response = await mcp.call('get_products', request);
  contextId = response.context_id; // Save for next call
  
  return response;
}
```

### A2A: Automatic Context
```javascript
// A2A manages context automatically
const response1 = await a2a.send({ message: "Find video products" });
const response2 = await a2a.send({ 
  contextId: response1.contextId, // Optional - A2A tracks this
  message: "Focus on premium inventory" 
});
```

## Operation Examples

### Product Discovery

**MCP:**
```javascript
const response = await mcp.call('get_products', {
  brief: "CTV campaign for sports fans",
  budget: 100000
});

if (response.status === 'completed') {
  console.log(response.data.products);
}
```

**A2A:**
```javascript
const response = await a2a.send({
  message: {
    parts: [{
      kind: "data",
      data: {
        skill: "get_products",
        parameters: {
          brief: "CTV campaign for sports fans",
          budget: 100000
        }
      }
    }]
  }
});

if (response.status === 'completed') {
  console.log(response.artifacts[0].parts[1].data.products);
}
```

## Error Handling

Both use `status: "failed"` with same error structure:

```json
{
  "status": "failed",
  "message": "Insufficient inventory for your targeting criteria",
  "context_id": "ctx-123",
  "data": {
    "error_code": "insufficient_inventory",
    "suggestions": ["Expand targeting", "Increase CPM"]
  }
}
```

## Choosing a Protocol

Choose based on your ecosystem and preferences:

### Choose MCP if you're using:
- Claude Desktop or Claude Code
- MCP-compatible AI assistants  
- Simple tool-based integrations
- Direct JSON responses

### Choose A2A if you're using:
- Google AI agents or Agent Engine
- Multi-modal workflows (text + files)
- Real-time streaming updates
- Artifact-based data handling

### Both protocols provide:
- ✅ Same AdCP tasks and capabilities
- ✅ Unified status system for clear client logic  
- ✅ Context management for conversations
- ✅ Async operation support
- ✅ Human-in-the-loop workflows
- ✅ Error handling and recovery

## Migration Between Protocols

The unified status system makes it easy to switch protocols:

```javascript
// Abstract client that works with both
class UnifiedAdcpClient {
  constructor(protocol, config) {
    this.client = protocol === 'mcp' 
      ? new McpClient(config)
      : new A2aClient(config);
  }
  
  async send(request) {
    const response = await this.client.send(request);
    
    // Normalize response format
    return {
      status: response.status,
      message: response.message || response.artifacts?.[0]?.parts?.[0]?.text,
      contextId: response.context_id || response.contextId,
      data: response.data || response.artifacts?.[0]?.parts?.[1]?.data
    };
  }
}
```

## Next Steps

- **Core Concepts**: Read [Core Concepts](./core-concepts.md) for status handling patterns
- **MCP Guide**: See [MCP Guide](./mcp-guide.md) for tool calls and context management
- **A2A Guide**: See [A2A Guide](./a2a-guide.md) for artifacts and streaming
- **Migration**: Both protocols provide the same capabilities with unified status handling