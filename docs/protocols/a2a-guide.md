---
sidebar_position: 3
title: A2A Guide
description: Integrate AdCP with Agent-to-Agent Protocol (A2A). Transport-specific guide for artifacts, SSE streaming, and agent cards.
keywords: [A2A integration, Agent-to-Agent Protocol, artifacts, SSE streaming, agent cards]
---

# A2A Integration Guide

Transport-specific guide for integrating AdCP using the Agent-to-Agent Protocol. For task handling, status management, and workflow patterns, see [Core Concepts](./core-concepts.md).

## A2A Client Setup

### 1. Initialize A2A Client

```javascript
const a2a = new A2AClient({
  endpoint: 'https://adcp.example.com/a2a',
  apiKey: process.env.ADCP_API_KEY,
  agent: {
    name: "AdCP Media Buyer",
    version: "1.0.0"
  }
});
```

### 2. Verify Agent Card

```javascript
// Check available skills
const agentCard = await a2a.getAgentCard();
console.log(agentCard.skills.map(s => s.name));
// ["get_products", "create_media_buy", "sync_creatives", ...]
```

### 3. Send Your First Task

```javascript
const response = await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "Find video products for pet food campaign"
    }]
  }
});

// All responses include unified status field (AdCP 1.6.0+)  
console.log(response.status);   // "completed" | "input-required" | "working" | etc.
console.log(response.message);  // Human-readable summary
```

## Message Structure (A2A-Specific)

### Multi-Part Messages

A2A's key advantage is multi-part messages combining text, data, and files:

```javascript
// Text + structured data + file
const response = await a2a.send({
  message: {
    parts: [
      {
        kind: "text",
        text: "Create campaign with these assets"
      },
      {
        kind: "data", 
        data: {
          skill: "create_media_buy",
          parameters: {
            packages: ["pkg_001"],
            total_budget: 100000
          }
        }
      },
      {
        kind: "file",
        uri: "https://cdn.example.com/hero-video.mp4",
        name: "hero_video_30s.mp4"
      }
    ]
  }
});
```

### Skill Invocation Methods

#### Natural Language (Flexible)
```javascript
// Agent interprets intent
const task = await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "Find premium CTV inventory under $50 CPM"
    }]
  }
});
```

#### Explicit Skill (Deterministic)
```javascript
// Explicit skill with exact parameters
const task = await a2a.send({
  message: {
    parts: [{
      kind: "data",
      data: {
        skill: "get_products",
        parameters: {
          max_cpm: 50,
          format_types: ["video"],
          tier: "premium"
        }
      }
    }]
  }
});
```

#### Hybrid Approach (Recommended)
```javascript
// Context + explicit execution for best results
const task = await a2a.send({
  message: {
    parts: [
      {
        kind: "text",
        text: "Looking for inventory for spring campaign targeting millennials"
      },
      {
        kind: "data", 
        data: {
          skill: "get_products",
          parameters: {
            audience: "millennials",
            season: "Q2_2024",
            max_cpm: 45
          }
        }
      }
    ]
  }
});
```

**Status Handling**: See [Core Concepts](./core-concepts.md) for complete status handling patterns.

## A2A Response Format

**New in AdCP 1.6.0**: All responses include unified status field.

### Response Structure
```json
{
  "status": "completed",        // Unified status (see Core Concepts)
  "taskId": "task-123",         // A2A task identifier
  "contextId": "ctx-456",       // Automatic context management
  "artifacts": [{               // A2A-specific artifact structure
    "name": "product_catalog",
    "parts": [
      {
        "kind": "text",
        "text": "Found 12 video products perfect for pet food campaigns"
      },
      {
        "kind": "data", 
        "data": {
          "products": [...],
          "total": 12
        }
      }
    ]
  }]
}
```

### A2A-Specific Fields
- **taskId**: A2A task identifier for streaming updates
- **contextId**: Automatically managed by A2A protocol
- **artifacts**: Multi-part deliverables (vs. MCP's direct data field)
- **status**: Same values as MCP for consistency

### Processing Artifacts
```javascript
function processA2aResponse(response) {
  // Extract human message
  const message = response.artifacts?.[0]?.parts
    ?.find(p => p.kind === 'text')?.text;
    
  // Extract structured data
  const data = response.artifacts?.[0]?.parts
    ?.find(p => p.kind === 'data')?.data;
    
  return { message, data, status: response.status };
}
```

## SSE Streaming (A2A-Specific)

A2A's key advantage is real-time updates via Server-Sent Events:

### Task Monitoring

```javascript
class A2aTaskMonitor {
  constructor(taskId) {
    this.taskId = taskId;
    this.events = new EventSource(`/a2a/tasks/${taskId}/events`);
    
    this.events.addEventListener('status', (e) => {
      const update = JSON.parse(e.data);
      this.handleStatusUpdate(update);
    });
    
    this.events.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      console.log(`${data.percentage}% - ${data.message}`);
    });
  }
  
  handleStatusUpdate(update) {
    switch (update.status) {
      case 'input-required':
        // Handle clarification/approval needed
        this.emit('input-required', update);
        break;
      case 'completed':
        this.events.close();
        this.emit('completed', update);
        break;
      case 'failed':
        this.events.close();
        this.emit('failed', update);
        break;
    }
  }
}
```

### Real-Time Updates Example

```javascript
// Start long-running operation
const response = await a2a.send({
  message: {
    parts: [{
      kind: "data",
      data: {
        skill: "create_media_buy",
        parameters: { packages: ["pkg_001"], total_budget: 100000 }
      }
    }]
  }
});

// Monitor in real-time
if (response.status === 'working') {
  const monitor = new A2aTaskMonitor(response.taskId);
  
  monitor.on('progress', (data) => {
    updateUI(`${data.percentage}%: ${data.message}`);
  });
  
  monitor.on('completed', (final) => {
    console.log('Created:', final.artifacts[0].parts[1].data.media_buy_id);
  });
}
```

## Context Management (A2A-Specific)

**Key Advantage**: A2A handles context automatically - no manual context_id management needed.

### Automatic Context

```javascript
// First request - A2A creates context automatically
const response1 = await a2a.send({
  message: {
    parts: [{ kind: "text", text: "Find premium video products" }]
  }
});

// Follow-up - A2A remembers context automatically  
const response2 = await a2a.send({
  message: {
    parts: [{ kind: "text", text: "Filter for sports content" }]
  }
});
// System automatically connects this to previous request
```

### Explicit Context (Optional)

```javascript
// When you need explicit control
const response2 = await a2a.send({
  contextId: response1.contextId,  // Optional - A2A tracks this anyway
  message: {
    parts: [{ kind: "text", text: "Refine those results" }]
  }
});
```

**vs. MCP**: Unlike MCP's manual context_id management, A2A handles session continuity at the protocol level.

## Multi-Modal Messages (A2A-Specific)

A2A's unique capability - combine text, data, and files in one message:

### Creative Upload with Context

```javascript
// Upload creative with campaign context in single message
const response = await a2a.send({
  message: {
    parts: [
      {
        kind: "text",
        text: "Add this hero video to the premium sports campaign"
      },
      {
        kind: "data",
        data: {
          skill: "sync_creatives",
          parameters: {
            media_buy_id: "mb_12345",
            action: "upload_and_assign"
          }
        }
      },
      {
        kind: "file",
        uri: "https://cdn.example.com/hero-30s.mp4",
        name: "sports_hero_30s.mp4"
      }
    ]
  }
});
```

### Campaign Brief + Assets

```javascript
// Submit comprehensive campaign brief
await a2a.send({
  message: {
    parts: [
      {
        kind: "text",
        text: "Campaign brief and assets for Q1 launch"
      },
      {
        kind: "file",
        uri: "https://docs.google.com/campaign-brief.pdf",
        name: "Q1_campaign_brief.pdf"
      },
      {
        kind: "data",
        data: {
          budget: 250000,
          kpis: ["reach", "awareness", "conversions"],
          target_launch: "2024-01-15"
        }
      }
    ]
  }
});
```

## Available Skills

All AdCP tasks are available as A2A skills. Use explicit invocation for deterministic execution:

### Skill Structure
```javascript
// Standard pattern for explicit skill invocation
await a2a.send({
  message: {
    parts: [{
      kind: "data",
      data: {
        skill: "skill_name",        // Exact name from Agent Card
        parameters: {              // Task-specific parameters
          // See task documentation for parameters
        }
      }
    }]
  }
});
```

### Available Skills
- **Media Buy**: `get_products`, `list_creative_formats`, `create_media_buy`, `update_media_buy`, `sync_creatives`, `get_media_buy_delivery`, `list_authorized_properties`, `provide_performance_feedback`
- **Signals**: `get_signals`, `activate_signal`

**Task Parameters**: See [Media Buy](../media-buy/index.md) and [Signals](../signals/overview.md) documentation for complete parameter specifications.

## Agent Cards

A2A agents advertise capabilities via Agent Cards at `.well-known/agent.json`:

### Discovering Agent Cards
```javascript
// Get agent capabilities
const agentCard = await a2a.getAgentCard();

// List available skills
const skillNames = agentCard.skills.map(skill => skill.name);
console.log('Available skills:', skillNames);

// Get skill details
const getProductsSkill = agentCard.skills.find(s => s.name === 'get_products');
console.log('Examples:', getProductsSkill.examples);
```

### Sample Agent Card Structure
```json
{
  "name": "AdCP Media Buy Agent",
  "description": "AI-powered media buying agent",
  "skills": [
    {
      "name": "get_products",
      "description": "Discover available advertising products",
      "examples": [
        "Find premium CTV inventory for sports fans",
        "Show me video products under $50 CPM"
      ]
    }
  ]
}
```

## Integration Example

```javascript
// Initialize A2A client  
const a2a = new A2AClient({ /* config */ });

// Use unified status handling (see Core Concepts)
async function handleA2aResponse(response) {
  switch (response.status) {
    case 'input-required':
      // Handle clarification (see Core Concepts for patterns)
      const input = await promptUser(response.message);
      return a2a.send({
        contextId: response.contextId,
        message: { parts: [{ kind: "text", text: input }] }
      });
      
    case 'working':
      // Monitor via SSE streaming
      return streamUpdates(response.taskId);
      
    case 'completed':
      return response.artifacts[0].parts[1].data;
      
    case 'failed':
      throw new Error(response.message);
  }
}

// Example usage with multi-modal message
const result = await a2a.send({
  message: {
    parts: [
      { kind: "text", text: "Find luxury car inventory" },
      { kind: "data", data: { skill: "get_products", parameters: { audience: "luxury car intenders" } } }
    ]
  }
});

const finalResult = await handleA2aResponse(result);
```

## A2A-Specific Considerations

### Error Handling
```javascript
// A2A transport vs. task errors
try {
  const response = await a2a.send(message);
  
  if (response.status === 'failed') {
    // AdCP task error - show to user
    showError(response.message);
  }
} catch (a2aError) {
  // A2A transport error (connection, auth, etc.)
  console.error('A2A Error:', a2aError);
}
```

### File Upload Validation
```javascript
// A2A validates file types automatically
const response = await a2a.send({
  message: {
    parts: [
      { kind: "text", text: "Upload creative asset" },
      { kind: "file", uri: "https://example.com/video.mp4", name: "hero.mp4" }
    ]
  }
});

// Check for file validation issues
if (response.status === 'failed' && response.data?.file_errors) {
  console.log('File issues:', response.data.file_errors);
}
```

## Best Practices

1. **Use hybrid messages** for best results (text + data + optional files)
2. **Check status field** before processing artifacts  
3. **Leverage SSE streaming** for real-time updates on long operations
4. **Reference Core Concepts** for status handling patterns
5. **Use agent cards** to discover available skills and examples

## Next Steps

- **Core Concepts**: Read [Core Concepts](./core-concepts.md) for status handling and workflows  
- **Task Reference**: See [Media Buy Tasks](../media-buy/index.md) and [Signals](../signals/overview.md)
- **Protocol Comparison**: Compare with [MCP integration](./mcp-guide.md)
- **Examples**: Find complete workflow examples in Core Concepts

**For status handling, async operations, and clarification patterns, see [Core Concepts](./core-concepts.md) - this guide focuses on A2A transport specifics only.**