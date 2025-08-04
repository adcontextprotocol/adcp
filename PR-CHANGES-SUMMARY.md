# Task-Based Protocol Documentation Changes

## Summary
This PR refactors AdCP documentation to be task-based and adds multi-protocol support.

## 1. NEW FILES TO CREATE

### docs/protocols/overview.md
```markdown
---
sidebar_position: 1
title: Protocol Support
---

# Protocol Support

AdCP is designed to work with multiple communication protocols, allowing implementers to choose the best fit for their use case. All AdCP tasks can be accessed through any supported protocol.

## Supported Protocols

### Model Context Protocol (MCP)

MCP is Anthropic's protocol for AI-to-application communication. It provides:
- Synchronous request/response model
- Tool-based interactions
- Simple integration with Claude and other AI assistants

**Best for:**
- Direct AI assistant integration
- Simple request/response workflows
- Existing MCP ecosystems

**Learn more:** [MCP Integration Guide](./mcp.md)

### Agent2Agent Protocol (A2A)

A2A is Google's protocol for agent-to-agent communication. It provides:
- Task-based asynchronous workflows
- Native human-in-the-loop support
- Real-time status updates via SSE
- Context management across interactions

**Best for:**
- Complex multi-step workflows
- Operations requiring approvals
- Cross-agent collaboration
- Long-running operations

**Learn more:** [A2A Integration Guide](./a2a.md)

### REST API (Coming Soon)

Traditional REST endpoints for direct HTTP integration.

**Best for:**
- Simple integrations
- Existing REST infrastructure
- Direct API access

## How It Works

AdCP uses a task-first architecture where:

1. **Core Tasks**: Business logic is implemented as tasks (e.g., `create_media_buy`, `get_signals`)
2. **Protocol Adapters**: Thin translation layers expose tasks through different protocols
3. **Consistent Behavior**: The same task works identically across all protocols

```
         ┌──────────┐ ┌──────────┐ ┌──────────┐
         │   MCP    │ │   A2A    │ │   REST   │
         │ Adapter  │ │ Adapter  │ │ Adapter  │
         └────┬─────┘ └────┬─────┘ └────┬─────┘
              └────────┬────┴────────────┘
                       ▼
              ┌─────────────────┐
              │  AdCP Tasks     │
              │                 │
              │ • get_signals   │
              │ • activate_signal│
              │ • create_media_buy│
              │ • add_creatives │
              └─────────────────┘
```

## Choosing a Protocol

| Feature | MCP | A2A | REST |
|---------|-----|-----|------|
| **Async Operations** | Polling | Native | Polling |
| **Status Updates** | Manual | Streaming | Manual |
| **Human-in-the-Loop** | Custom | Native | Custom |
| **Context Management** | Manual | Automatic | Manual |
| **Complexity** | Low | Medium | Low |

## Implementation Notes

- All protocols provide access to the same underlying tasks
- Protocol choice doesn't affect functionality, only the interaction model
- Implementers can support multiple protocols simultaneously
- New protocols can be added without changing core task implementations
```

### docs/protocols/mcp.md
```markdown
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
```

### docs/protocols/a2a.md
```markdown
---
sidebar_position: 3
title: A2A Integration
---

# A2A (Agent2Agent) Integration

AdCP's A2A integration enables rich agent-to-agent collaboration with native support for complex workflows.

## Overview

A2A is Google's protocol designed for agent communication. It provides task-based interactions with built-in support for:
- Asynchronous operations
- Real-time status updates
- Human-in-the-loop workflows
- Context preservation

## How AdCP Tasks Work in A2A

AdCP tasks map naturally to A2A's task model:

```json
// A2A Request
{
  "method": "message/send",
  "params": {
    "message": {
      "parts": [{
        "kind": "text",
        "text": "Create a $50K CTV campaign for pet food"
      }]
    }
  }
}

// A2A Response with Task
{
  "taskId": "task-mb-001",
  "contextId": "ctx-campaign-123",
  "status": { "state": "working" }
}
```

## Status Updates via SSE

A2A provides real-time updates through Server-Sent Events:

```javascript
// Client subscribes to updates
const events = new EventSource('/a2a/tasks/task-mb-001/events');

events.onmessage = (event) => {
  const update = JSON.parse(event.data);
  console.log(update.message);
  // "Validating campaign parameters..."
  // "Checking inventory availability..."
  // "Creating in ad server..."
};
```

## Context Management

A2A's `contextId` maintains conversation state across interactions:

```json
// First interaction: Upload creative
{
  "message": {
    "parts": [{
      "kind": "text",
      "text": "Upload creative for campaign"
    }, {
      "kind": "file",
      "uri": "https://cdn.example.com/video.mp4"
    }]
  }
}
// Response includes contextId: "ctx-creative-456"

// Second interaction: Request changes (same context)
{
  "contextId": "ctx-creative-456",
  "message": {
    "parts": [{
      "kind": "text", 
      "text": "Create a 15-second version"
    }]
  }
}
```

## Human-in-the-Loop Workflows

A2A handles HITL natively with task states:

```json
// Task enters pending_approval state
{
  "taskId": "task-mb-002",
  "status": {
    "state": "pending_approval",
    "metadata": {
      "approvalType": "budget_approval",
      "reason": "Exceeds automatic approval threshold"
    }
  }
}

// Approver responds in same context
{
  "contextId": "ctx-campaign-123",
  "message": {
    "parts": [{
      "kind": "text",
      "text": "Approved - proceed with campaign"
    }]
  }
}

// Task resumes automatically
{
  "status": { "state": "working" },
  "message": "Creating campaign with approved budget..."
}
```

## Example: Complete Media Buy Flow

```javascript
// 1. Natural language request
const task = await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "I need a $100K connected TV campaign targeting sports fans in California"
    }]
  }
});

// 2. Receive streaming updates
// "Analyzing your requirements..."
// "Found 12 suitable CTV products"
// "Optimizing budget allocation..."
// "Pending compliance approval..."

// 3. Handle approval in context
await a2a.send({
  contextId: task.contextId,
  message: {
    parts: [{
      kind: "text",
      text: "Approved by compliance team"
    }]
  }
});

// 4. Continue with creatives (same context)
await a2a.send({
  contextId: task.contextId,
  message: {
    parts: [{
      kind: "text",
      text: "Upload our hero creative"
    }, {
      kind: "file",
      uri: "https://cdn.example.com/hero.mp4"
    }]
  }
});
```

## Artifacts

A2A returns structured results as artifacts:

```json
{
  "status": { "state": "completed" },
  "artifacts": [{
    "name": "media_buy_confirmation",
    "parts": [
      {
        "kind": "application/json",
        "data": {
          "media_buy_id": "mb_123",
          "status": "active",
          "packages": [...]
        }
      },
      {
        "kind": "application/pdf",
        "uri": "https://contracts.example.com/io_123.pdf"
      }
    ]
  }]
}
```

## Best Practices

1. **Leverage Context**: Use `contextId` for multi-step workflows
2. **Subscribe to Updates**: Use SSE for real-time progress
3. **Natural Language**: A2A works well with conversational requests
4. **Handle All States**: Design for pending, working, and failed states

## A2A-Specific Features

### Push Notifications
Configure webhooks for task updates:
```json
{
  "configuration": {
    "pushNotificationConfig": {
      "url": "https://myapp.com/webhooks/a2a",
      "token": "secure-token"
    }
  }
}
```

### Multi-Modal Support
A2A handles various content types:
- Text instructions
- File uploads (images, videos, PDFs)
- Structured data (JSON)
- Mixed content in single message

### Agent Capabilities
Agents advertise capabilities via Agent Cards:
```json
{
  "name": "AdCP Media Buy Agent",
  "skills": [
    {
      "name": "campaign_creation",
      "examples": [
        "Create a $50K CTV campaign",
        "Launch a holiday audio campaign"
      ]
    }
  ]
}
```

## Advantages Over MCP

- **Native Async**: No polling required
- **Built-in HITL**: Task states handle approvals naturally
- **Context Preservation**: Conversations maintain state
- **Richer Interactions**: Multi-modal messages with files and data
- **Real-time Updates**: SSE provides immediate feedback
```

## 2. FILES TO UPDATE

### docs/intro.md
In the "What is Ad Context Protocol?" section, REPLACE:
```markdown
## What is Ad Context Protocol?

Ad Context Protocol is an open standard based on the Model Context Protocol (MCP) that allows:

- **Natural Language Interaction**: Describe what you want in plain English
- **Platform Agnostic**: Works with any compatible advertising platform
- **AI-Powered**: Designed for integration with AI assistants like Claude, GPT, and others
```

WITH:
```markdown
## What is Ad Context Protocol?

Ad Context Protocol is an open standard that enables AI-powered advertising workflows through:

- **Natural Language Interaction**: Describe what you want in plain English
- **Platform Agnostic**: Works with any compatible advertising platform
- **Multi-Protocol Support**: Access AdCP through MCP, A2A, or future protocols
- **AI-Powered**: Designed for integration with AI assistants and agents

AdCP uses a task-first architecture where core advertising tasks (like creating media buys or discovering signals) can be accessed through multiple protocols:
- **MCP (Model Context Protocol)**: For direct AI assistant integration
- **A2A (Agent2Agent Protocol)**: For complex workflows and agent collaboration
- **REST API**: Coming soon for traditional integrations
```

ADD before "## Next Steps":
```markdown
## Protocol Flexibility

AdCP's task-first architecture means you can access the same functionality through different protocols:

- **Using MCP**: Ideal for Claude and other AI assistants with direct tool integration
- **Using A2A**: Perfect for complex workflows with approvals and multi-agent collaboration
- **Protocol Agnostic**: Implementers write tasks once, support all protocols automatically

Learn more in the [Protocols section](./protocols/overview).
```

### docs/signals/specification.md
1. REPLACE `## Protocol Specification` with:
```markdown
## Tasks

The Signals Activation Protocol defines the following tasks that agents can perform:
```

2. For `### get_signals`, ADD after the heading:
```markdown
**Task**: Discover relevant signals based on a marketing specification across multiple platforms.
```

3. For `### activate_signal`, REPLACE the heading and first line with:
```markdown
### activate_signal

**Task**: Activate a signal for use on a specific platform/account.

This task handles the entire activation lifecycle, including:
- Initiating the activation request
- Monitoring activation progress
- Returning the final deployment status
```

4. REMOVE the entire `### check_signal_status` section

5. In the response section for activate_signal, REPLACE the simple response with:
```markdown
#### Response

The task provides status updates as the activation progresses:

**Initial Response** (immediate):
```json
{
  "task_id": "activation_12345",
  "status": "pending",
  "decisioning_platform_segment_id": "pm_brand456_peer39_lux_auto",
  "estimated_activation_duration_minutes": 60
}
```

**Status Updates** (streamed or polled):
```json
{
  "task_id": "activation_12345",
  "status": "processing",
  "message": "Validating signal access permissions..."
}
```

**Final Response** (when complete):
```json
{
  "task_id": "activation_12345",
  "status": "deployed",
  "decisioning_platform_segment_id": "pm_brand456_peer39_lux_auto",
  "deployed_at": "2025-01-15T14:30:00Z",
  "message": "Signal successfully activated on PubMatic"
}
```
```

6. In all workflow sections, REMOVE references to `check_signal_status` and update to mention that activate_signal handles monitoring

### docs/signals/overview.md
REPLACE the "## The Four Essential Tools" section with:
```markdown
## Core Tasks

The Signals Activation Protocol supports two primary tasks:

### 1. get_signals
**Task**: Discover signals based on your campaign needs across one or many platforms.

### 2. activate_signal  
**Task**: Activate signals for specific platforms and accounts. This task handles the complete activation lifecycle including progress monitoring and status updates.
```

### docs/media-buy/api-reference.md
1. REPLACE `## API Tools Reference` with:
```markdown
## Tasks

The Media Buy Protocol defines the following tasks that agents can perform:
```

2. For each numbered section (e.g., "### 1. list_creative_formats"), ADD a task description after the heading:
   - `### 1. list_creative_formats` → Add: `**Task**: Discover all supported creative formats in the system.`
   - `### 2. create_media_buy` → Add: `**Task**: Create a media buy from selected packages. This task handles the complete workflow including validation, approval if needed, and campaign creation.`
   - `### 3. add_creative_assets` → Add: `**Task**: Upload creative assets and assign them to packages. This task includes validation, policy review, and format adaptation suggestions.`
   - etc.

### docs/media-buy/index.md
REPLACE:
```markdown
- **[API Reference](api-reference.md)** - Complete tool documentation with examples
```

WITH:
```markdown
- **[API Reference](api-reference.md)** - Complete task documentation with examples
```

### sidebars.ts
ADD after 'intro' and before the Signals section:
```typescript
{
  type: 'category',
  label: 'Protocols',
  items: [
    'protocols/overview',
    'protocols/mcp',
    'protocols/a2a',
  ],
},
```

## 3. FILES TO DELETE

Remove these directories and all their contents:
- `docs/architecture/` (entire directory)
- `examples/a2a-integration/` (entire directory)
- `examples/task-first/` (entire directory)

## PR Description

Title: refactor: update AdCP docs to be task-based and multi-protocol

Description:
```
## Summary

This PR refactors AdCP documentation to be task-based and adds multi-protocol support.

## Changes Made:

### 1. Task-Based Descriptions
- Updated Signals protocol to describe `get_signals` and `activate_signal` as tasks
- Updated Media Buy protocol to describe all operations as tasks
- Removed `check_signal_status` - now part of `activate_signal` task lifecycle

### 2. New Protocols Section
- Added `docs/protocols/overview.md` - Overview of protocol options
- Added `docs/protocols/mcp.md` - MCP integration guide
- Added `docs/protocols/a2a.md` - A2A integration guide
- Updated sidebar to include Protocols section

### 3. Updated Getting Started
- Added multi-protocol support as a key feature
- Explained AdCP's protocol flexibility
- Added Protocol Flexibility section with links

### 4. Removed Architecture Documents
- Removed all files in `docs/architecture/` 
- Removed all example files

## Key Improvements:

- Documentation uses consistent task-based terminology
- Protocol support is presented as a simple choice based on use case
- Focus on practical information users need
- No overwhelming architectural theory

The documentation now clearly communicates that AdCP is a task-based protocol accessible through multiple communication protocols.
```