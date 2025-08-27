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

// 4. Task completes
// Result includes media_buy_id and confirmation
// Note: Adding creatives would be a separate task with its own context
```

## Artifacts vs Messages in A2A

### Messages
Used for communication during task execution:
- Status updates and progress reports
- Clarification requests and questions
- Interim feedback and notifications
- Human-in-the-loop interactions

### Artifacts
Used for tangible outputs from completed work:
- Query results (product catalogs, delivery reports)
- Created entities (media buy confirmations, creative assignments)
- Processed files (validated creatives, generated contracts)
- Final deliverables and work products

### AdCP Implementation Strategy

AdCP uses artifacts for all task results to ensure:
- **Structured Data Delivery**: Consistent format across all tasks
- **Multi-Part Support**: Combine JSON data with files (contracts, reports)
- **Protocol Consistency**: Same data structure as MCP responses

### Artifact Structure

A2A returns structured results as artifacts:

```json
{
  "task": {
    "task_id": "task-mb-123",
    "status": "completed"
  },
  "contextId": "ctx-campaign-456", 
  "artifacts": [{
    "name": "media_buy_confirmation",
    "parts": [{
      "kind": "data",
      "data": {
        "media_buy_id": "mb_123",
        "status": "active",
        "packages": [...],
        "line_items": [...],
        "total_budget": 100000
      }
    }, {
      "kind": "file",
      "uri": "https://contracts.example.com/mb_123.pdf"
    }]
  }]
}
```

See [Artifacts and Responses](./artifacts-and-responses.md) for detailed implementation guidance and [Task Response Patterns](./task-response-patterns.md) for specific examples by task type.

## Best Practices

1. **Leverage Context**: Use `contextId` for multi-step workflows
2. **Subscribe to Updates**: Use SSE for real-time progress
3. **Natural Language**: A2A works well with conversational requests
4. **Handle All States**: Design for pending, working, and failed states

## A2A-Specific Features

### Push Notifications
Buyers can configure webhooks as an alternative to SSE for receiving task updates:
```json
// Buyer configures their webhook endpoint
{
  "configuration": {
    "pushNotificationConfig": {
      "url": "https://buyer-app.com/webhooks/a2a",
      "token": "secure-token"
    }
  }
}

// Publisher sends updates to the configured webhook
// instead of requiring the buyer to maintain SSE connection
```

### Multi-Modal Support
A2A handles various content types:
- Text instructions
- File uploads (images, videos, documents)
- Structured data (JSON)
- Mixed content in single message

### Agent Capabilities
Agents advertise capabilities via Agent Cards. This is particularly useful when an agent offers unique capabilities beyond the standard AdCP specification:

```json
{
  "name": "AdCP Media Buy Agent",
  "version": "1.0.0",
  "adcp_compliant": true,
  "standard_tasks": [
    "get_products",
    "create_media_buy",
    "add_creative_assets"
  ],
  "unique_capabilities": [
    {
      "name": "campaign_optimization",
      "description": "AI-powered campaign optimization",
      "examples": [
        "Optimize my campaign for better CTR",
        "Reallocate budget to top performers"
      ]
    },
    {
      "name": "competitive_analysis",
      "description": "Analyze competitor campaigns",
      "examples": [
        "Show me what my competitors are running",
        "Compare my campaign to industry benchmarks"
      ]
    }
  ]
}
```

For standard AdCP tasks, agents should follow the specification. The Agent Card primarily highlights additional capabilities that differentiate the agent.

## Advantages Over MCP

- **Native Async**: No polling required
- **Built-in HITL**: Task states handle approvals naturally
- **Context Preservation**: Conversations maintain state
- **Richer Interactions**: Multi-modal messages with files and data
- **Real-time Updates**: SSE provides immediate feedback