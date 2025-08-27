---
sidebar_position: 3
title: A2A Guide
---

# A2A Integration Guide

Everything you need to integrate AdCP using the Agent-to-Agent Protocol.

## Quick Start

### 1. Initialize A2A Connection

```javascript
const a2a = new A2AClient({
  endpoint: 'https://adcp.example.com/a2a',
  apiKey: process.env.ADCP_API_KEY
});
```

### 2. Send Your First Message

```javascript
// Natural language request
const task = await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "I need video products for a pet food campaign"
    }]
  }
});

// Subscribe to updates
task.on('update', (status) => {
  console.log(status.message);
});

// Get final result
const result = await task.complete();
console.log(result.artifacts);
```

## Understanding A2A Responses

A2A uses two types of responses:

### Messages (Communication)
For conversations, clarifications, and updates:

```json
{
  "message": {
    "parts": [{
      "kind": "text",
      "text": "I'd be happy to help. What's your campaign budget?"
    }]
  },
  "artifacts": []
}
```

### Artifacts (Deliverables)
For actual results and data:

```json
{
  "artifacts": [{
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

## Common Workflows

### Product Discovery with Clarification

```javascript
// Initial request (vague)
const task = await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "I need to run some video ads"
    }]
  }
});

// A2A asks for clarification
// Response: "I'd be happy to help. Could you share your budget and target audience?"

// Provide more details
const refined = await a2a.send({
  contextId: task.contextId,
  message: {
    parts: [{
      kind: "text", 
      text: "Budget is $50K, targeting pet owners in California"
    }]
  }
});

// Now get results with artifacts
console.log(refined.artifacts[0].parts[1].data.products);
```

### Creating a Media Buy with Approvals

```javascript
// Request media buy creation
const task = await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "Create a $100K CTV campaign for sports fans in NY and CA"
    }]
  }
});

// Monitor progress via SSE
const events = new EventSource(`/a2a/tasks/${task.taskId}/events`);

events.onmessage = (event) => {
  const update = JSON.parse(event.data);
  console.log(update.message);
  // "Validating inventory..."
  // "Checking budget approval..."
  // "Pending human approval - budget exceeds auto-approval limit"
};

// Handle approval request
if (task.status === 'pending_approval') {
  // Approve in same context
  await a2a.send({
    contextId: task.contextId,
    message: {
      parts: [{
        kind: "text",
        text: "Approved - proceed with campaign creation"
      }]
    }
  });
}

// Get final confirmation
const result = await task.complete();
const mediaBuyId = result.artifacts[0].parts[1].data.media_buy_id;
```

### Uploading Creatives

```javascript
// Upload with file parts
const task = await a2a.send({
  contextId: existingContext,
  message: {
    parts: [
      {
        kind: "text",
        text: "Add this creative to media buy MB-12345"
      },
      {
        kind: "file",
        uri: "https://cdn.example.com/hero-video.mp4",
        name: "hero_video_30s.mp4"
      }
    ]
  }
});

// Get processing updates
// "Validating creative format..."
// "Checking compliance..."
// "Creative approved and assigned"
```

## Real-time Updates with SSE

A2A provides real-time updates through Server-Sent Events:

```javascript
class A2ATaskMonitor {
  constructor(taskId) {
    this.events = new EventSource(`/a2a/tasks/${taskId}/events`);
    
    this.events.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      console.log(`Progress: ${data.percentage}% - ${data.message}`);
    });
    
    this.events.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      if (data.state === 'completed') {
        this.events.close();
      }
    });
  }
}
```

## Context Management

A2A handles context automatically at the protocol level:

```javascript
// A2A maintains session state automatically
const task1 = await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "Show me premium video inventory"
    }]
  }
});

// The protocol tracks context - you can reference it if needed
// but A2A manages the session for you
const task2 = await a2a.send({
  contextId: task1.contextId,  // Optional - A2A maintains this automatically
  message: {
    parts: [{
      kind: "text",
      text: "Filter for sports-related content"
    }]
  }
});
// System understands this refers to the premium video inventory
```

**Key Advantage**: Unlike MCP which requires manual context_id management, A2A handles session continuity automatically through the protocol. The contextId is available if you need explicit control, but the protocol maintains state for you.

## Human-in-the-Loop Workflows

A2A natively handles workflows requiring human intervention:

```javascript
async function handleApprovalWorkflow(task) {
  // Monitor task status
  const monitor = new TaskMonitor(task.taskId);
  
  monitor.on('pending_approval', async (details) => {
    console.log(`Approval needed: ${details.reason}`);
    
    // Get human decision (from UI, Slack, etc.)
    const decision = await getHumanApproval(details);
    
    // Send decision in context
    await a2a.send({
      contextId: task.contextId,
      message: {
        parts: [{
          kind: "text",
          text: decision.approved 
            ? `Approved: ${decision.notes}`
            : `Rejected: ${decision.reason}`
        }]
      }
    });
  });
  
  return monitor.waitForCompletion();
}
```

## Multi-Modal Support

A2A handles various content types in a single message:

```javascript
// Mixed content message
await a2a.send({
  message: {
    parts: [
      {
        kind: "text",
        text: "Here's my creative brief and assets"
      },
      {
        kind: "file",
        uri: "https://drive.google.com/brief.pdf",
        name: "creative_brief.pdf"
      },
      {
        kind: "data",
        data: {
          campaignGoals: ["awareness", "consideration"],
          kpis: ["reach", "video_completion_rate"]
        }
      }
    ]
  }
});
```

## Complete Example

Here's a full campaign creation workflow using A2A:

```javascript
async function createCampaignWithA2A() {
  const a2a = new A2AClient({ /* config */ });
  
  // 1. Natural language product discovery
  const discovery = await a2a.send({
    message: {
      parts: [{
        kind: "text",
        text: `I need to create a Q1 campaign for BMW Series 5.
               Budget is $200K, targeting luxury car intenders.
               Looking for premium CTV and audio inventory.`
      }]
    }
  });
  
  // Monitor discovery progress
  discovery.on('update', console.log);
  
  // 2. Get product recommendations
  const products = await discovery.complete();
  console.log(`Found ${products.artifacts[0].parts[1].data.total} products`);
  
  // 3. Create media buy (may need approval)
  const mediaBuy = await a2a.send({
    contextId: discovery.contextId,
    message: {
      parts: [{
        kind: "text",
        text: "Create media buy with top 5 recommended products"
      }]
    }
  });
  
  // 4. Handle approval if needed
  if (mediaBuy.status === 'pending_approval') {
    console.log('Awaiting approval...');
    
    // Send approval
    await a2a.send({
      contextId: mediaBuy.contextId,
      message: {
        parts: [{
          kind: "text",
          text: "Approved by Marketing Director"
        }]
      }
    });
  }
  
  // 5. Upload creatives
  const creativeUpload = await a2a.send({
    contextId: mediaBuy.contextId,
    message: {
      parts: [
        {
          kind: "text",
          text: "Add approved BMW creatives"
        },
        {
          kind: "file",
          uri: "https://cdn.bmw.com/hero-30s.mp4"
        },
        {
          kind: "file", 
          uri: "https://cdn.bmw.com/hero-15s.mp4"
        }
      ]
    }
  });
  
  // 6. Get final confirmation
  const result = await creativeUpload.complete();
  console.log('Campaign ready:', result.artifacts);
}
```

## Best Practices

### 1. Distinguish Messages from Artifacts
```javascript
// Check what type of response
if (response.artifacts && response.artifacts.length > 0) {
  // Process deliverables
  handleArtifacts(response.artifacts);
} else if (response.message) {
  // Handle communication
  displayMessage(response.message.parts[0].text);
}
```

### 2. Use Context for Conversations
```javascript
class A2AConversation {
  constructor(client) {
    this.client = client;
    this.contextId = null;
  }
  
  async send(text) {
    const response = await this.client.send({
      contextId: this.contextId,
      message: {
        parts: [{ kind: "text", text }]
      }
    });
    
    this.contextId = response.contextId;
    return response;
  }
}
```

### 3. Handle Multi-Part Artifacts
```javascript
function processArtifact(artifact) {
  artifact.parts.forEach(part => {
    switch(part.kind) {
      case 'text':
        console.log(part.text);  // Human-readable summary
        break;
      case 'data':
        processData(part.data);  // Structured data
        break;
      case 'file':
        downloadFile(part.uri);  // External file
        break;
    }
  });
}
```

## Troubleshooting

### Common Issues

**"Task not found"**
- Tasks expire after completion
- Store results if needed for later

**"Context expired"**  
- Contexts timeout after 1 hour of inactivity
- Start a new conversation

**"No artifacts in response"**
- Check if response is a message (clarification)
- Provide requested information and retry

## Next Steps

- Explore [Media Buy Tasks](../media-buy/tasks/get_products.md)
- Learn about [Signals](../signals/overview.md)  
- Compare with [MCP](./mcp-guide.md) if curious
- See [Protocol Comparison](./protocol-comparison.md) for differences

## Need More Detail?

Most users only need this guide. For deep technical specifications, see the [Reference](../reference/data-models.md) section.