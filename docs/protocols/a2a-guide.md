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

## Skill Invocation

A2A supports two methods for invoking skills:

### Natural Language Invocation
The agent interprets natural language to determine which skill to execute:

```javascript
// Agent infers this should use the get_products skill
const task = await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "Find premium CTV inventory for sports fans"
    }]
  }
});
```

### Explicit Skill Invocation
For deterministic execution, explicitly specify the skill name and parameters:

```javascript
// Explicitly invoke the get_products skill
const task = await a2a.send({
  message: {
    parts: [
      {
        kind: "text",
        text: "Looking for video products"  // Optional human context
      },
      {
        kind: "data",
        data: {
          skill: "get_products",  // Exact skill name from Agent Card
          parameters: {
            audience: "sports fans",
            format: "video",
            max_cpm: 50,
            platforms: ["ctv", "online_video"]
          }
        }
      }
    ]
  }
});
```

**Important**: When using explicit invocation, the `skill` field must exactly match the skill name advertised in the Agent Card.

### Combining Natural Language with Explicit Skills
You can include both natural language context and explicit skill invocation:

```javascript
// Hybrid approach - provides context AND explicit execution
const task = await a2a.send({
  message: {
    parts: [
      {
        kind: "text",
        text: "I'm looking for inventory for our spring campaign targeting millennials"
      },
      {
        kind: "data", 
        data: {
          skill: "get_products",
          parameters: {
            audience: "millennials",
            season: "Q2_2024",
            categories: ["lifestyle", "entertainment"]
          }
        }
      }
    ]
  }
});
```

This hybrid approach:
- Provides human context for logging and understanding
- Ensures deterministic skill execution
- Allows the agent to use context for clarifications if needed

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

## AdCP Skill Examples

Here are explicit invocation examples for each AdCP skill:

### Media Buy Skills

#### get_products
```javascript
// Explicit skill invocation
await a2a.send({
  message: {
    parts: [
      {
        kind: "data",
        data: {
          skill: "get_products",
          parameters: {
            audience: "pet owners",
            geo: ["US-CA", "US-NY"],
            format: "video",
            max_cpm: 75,
            min_impressions: 1000000
          }
        }
      }
    ]
  }
});
```

#### list_creative_formats
```javascript
// List all supported formats
await a2a.send({
  message: {
    parts: [
      {
        kind: "data",
        data: {
          skill: "list_creative_formats",
          parameters: {
            category: "video"  // Optional: filter by category
          }
        }
      }
    ]
  }
});
```

#### create_media_buy
```javascript
// Create campaign with selected products
await a2a.send({
  message: {
    parts: [
      {
        kind: "data",
        data: {
          skill: "create_media_buy",
          parameters: {
            package_selections: [
              {
                package_id: "pkg_12345",
                budget_amount: 50000,
                impressions: 2000000
              },
              {
                package_id: "pkg_67890",
                budget_amount: 25000,
                impressions: 1000000
              }
            ],
            buyer_ref: "Q1_2024_campaign",
            start_date: "2024-01-01",
            end_date: "2024-03-31",
            pacing: "even"
          }
        }
      }
    ]
  }
});
```

#### add_creative_assets
```javascript
// Upload and assign creative assets
await a2a.send({
  message: {
    parts: [
      {
        kind: "data",
        data: {
          skill: "add_creative_assets",
          parameters: {
            media_buy_id: "mb_12345",
            assignments: [
              {
                package_id: "pkg_12345",
                format_id: "video_30s"
              }
            ]
          }
        }
      },
      {
        kind: "file",
        uri: "https://cdn.example.com/video-30s.mp4",
        name: "hero_video_30s.mp4"
      }
    ]
  }
});
```

#### get_media_buy_delivery
```javascript
// Get campaign performance metrics
await a2a.send({
  message: {
    parts: [
      {
        kind: "data",
        data: {
          skill: "get_media_buy_delivery",
          parameters: {
            media_buy_id: "mb_12345",
            date_range: {
              start: "2024-01-01",
              end: "2024-01-31"
            },
            metrics: ["impressions", "clicks", "video_completions"]
          }
        }
      }
    ]
  }
});
```

#### update_media_buy
```javascript
// Update campaign settings
await a2a.send({
  message: {
    parts: [
      {
        kind: "data",
        data: {
          skill: "update_media_buy",
          parameters: {
            media_buy_id: "mb_12345",
            updates: {
              budget_amount: 150000,
              pacing: "front_loaded",
              end_date: "2024-04-30"
            }
          }
        }
      }
    ]
  }
});
```

### Signals Skills

#### get_signals
```javascript
// Discover relevant signals
await a2a.send({
  message: {
    parts: [
      {
        kind: "data",
        data: {
          skill: "get_signals",
          parameters: {
            requirements: {
              audience: "luxury car intenders",
              categories: ["automotive", "lifestyle"],
              platforms: ["ttd", "amazon_dsp"]
            },
            limit: 10
          }
        }
      }
    ]
  }
});
```

#### activate_signal
```javascript
// Activate signal on platform
await a2a.send({
  message: {
    parts: [
      {
        kind: "data",
        data: {
          skill: "activate_signal",
          parameters: {
            signal_id: "sig_luxury_auto_123",
            platform: "ttd",
            account_id: "account_456",
            activation_name: "Q1_luxury_segment"
          }
        }
      }
    ]
  }
});
```

## Skill Response Formats

All skill invocations return results as artifacts with structured data:

### Successful Skill Response
```json
{
  "taskId": "task_123",
  "contextId": "ctx_456",
  "status": "completed",
  "artifacts": [
    {
      "name": "skill_result",
      "parts": [
        {
          "kind": "text",
          "text": "Human-readable summary of the result"
        },
        {
          "kind": "data",
          "data": {
            // Structured data specific to the skill
            // e.g., for get_products: { products: [...], total: 5 }
          }
        }
      ]
    }
  ]
}
```

### Asynchronous Skills
Some skills (like `create_media_buy` or `activate_signal`) may require time to complete:

1. **Initial Response**: Returns task ID with status "working"
2. **Status Updates**: Available via SSE at `/a2a/tasks/{taskId}/events`
3. **Final Result**: Contains artifacts with the completed data

### Error Responses
When a skill fails, the response includes an error message:

```json
{
  "taskId": "task_123",
  "status": "failed",
  "message": {
    "parts": [{
      "kind": "text",
      "text": "Unable to find products matching criteria: No inventory available for the specified audience"
    }]
  }
}
```

## Agent Cards for AdCP

A2A agents advertise their capabilities via Agent Cards served at `.well-known/agent.json`. Here are sample agent cards for AdCP implementations:

### Media Buy Agent Card

```json
{
  "name": "AdCP Media Buy Agent",
  "description": "AI-powered media buying agent for programmatic advertising",
  "skills": [
    {
      "name": "get_products",
      "description": "Discover available advertising products",
      "examples": [
        "Find premium CTV inventory for sports fans",
        "Show me video products under $50 CPM",
        "Get retail media products for pet owners"
      ]
    },
    {
      "name": "list_creative_formats",
      "description": "List supported creative formats",
      "examples": [
        "What video formats do you support?",
        "Show me IAB standard display formats"
      ]
    },
    {
      "name": "create_media_buy",
      "description": "Create a media buy campaign",
      "examples": [
        "Create a $100K campaign with these products",
        "Book premium CTV package for Q1"
      ]
    },
    {
      "name": "update_media_buy",
      "description": "Update an existing media buy",
      "examples": [
        "Increase budget to $150K",
        "Change pacing to front-loaded"
      ]
    },
    {
      "name": "add_creative_assets",
      "description": "Upload creative assets",
      "examples": [
        "Add this video creative to the campaign",
        "Upload display banners"
      ]
    },
    {
      "name": "get_media_buy_delivery",
      "description": "Get campaign performance metrics",
      "examples": [
        "Show delivery stats for my campaign",
        "How is the campaign performing?"
      ]
    }
  ]
}
```

### Signals Agent Card

```json
{
  "name": "AdCP Signals Agent",
  "description": "Signal discovery and activation for audience targeting",
  "skills": [
    {
      "name": "get_signals",
      "description": "Discover signals based on requirements",
      "examples": [
        "Find signals for luxury car buyers",
        "Get weather-based signals for beverages",
        "Show signals available on The Trade Desk"
      ]
    },
    {
      "name": "activate_signal",
      "description": "Activate signals on platforms",
      "examples": [
        "Activate this signal on The Trade Desk",
        "Deploy the luxury segment to Amazon DSP"
      ]
    }
  ]
}
```

## Complete Example

Here's a full campaign creation workflow using A2A:

```javascript
async function createCampaignWithA2A() {
  const a2a = new A2AClient({ /* config */ });
  
  // 1. Product discovery using explicit skill invocation
  const discovery = await a2a.send({
    message: {
      parts: [
        {
          kind: "text",
          text: "Finding inventory for BMW Q1 campaign"
        },
        {
          kind: "data",
          data: {
            skill: "get_products",
            parameters: {
              audience: "luxury car intenders",
              format: ["ctv", "audio"],
              tier: "premium",
              min_impressions: 5000000,
              max_cpm: 100
            }
          }
        }
      ]
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

### 1. Choose the Right Invocation Method
```javascript
// Use natural language for flexible, human-like interaction
if (userProvidedNaturalLanguageQuery) {
  await a2a.send({
    message: {
      parts: [{ kind: "text", text: userQuery }]
    }
  });
}

// Use explicit skills for programmatic, deterministic execution
if (needPredictableExecution) {
  await a2a.send({
    message: {
      parts: [{
        kind: "data",
        data: {
          skill: "get_products",
          parameters: structuredParams
        }
      }]
    }
  });
}
```

### 2. Distinguish Messages from Artifacts
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

### 3. Use Context for Conversations
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

### 4. Handle Multi-Part Artifacts
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