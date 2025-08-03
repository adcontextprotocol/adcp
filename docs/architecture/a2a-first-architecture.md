# A2A-First Architecture for AdCP

## Key Insight: Tasks as First-Class Citizens

After deeper analysis, it's clear that A2A's Task abstraction is fundamentally better suited for advertising workflows than MCP's request/response model. AdCP should be built on A2A's Task model with MCP as a compatibility layer.

## Why A2A Tasks Are Perfect for AdCP

### 1. Native Human-in-the-Loop Support

```javascript
// A2A Task naturally handles HITL
{
  "taskId": "task-media-buy-123",
  "status": {
    "state": "pending_approval",
    "message": "Awaiting human approval for $1M campaign"
  },
  "metadata": {
    "approvalRequired": true,
    "approver": "compliance@agency.com"
  }
}

// vs MCP requiring explicit HITL implementation
{
  "error": {
    "code": "APPROVAL_REQUIRED",
    "task_id": "task_123"  // Must build our own task system
  }
}
```

### 2. Progressive Status Updates

A2A Tasks can stream status updates as work progresses:

```javascript
// Creating a media buy with real-time updates
Task: "task-mb-456"
├── Status: "working" - "Checking inventory availability..."
├── Status: "working" - "Validating targeting parameters..."
├── Status: "working" - "Calculating optimal budget allocation..."
├── Status: "working" - "Submitting to ad server..."
├── Status: "pending_approval" - "Awaiting publisher approval..."
└── Status: "completed" - Media buy created: mb_789
```

### 3. Context Management for Multi-Step Workflows

The `contextId` naturally handles iterative workflows like creative management:

```javascript
// Initial creative upload
{
  "contextId": "ctx-campaign-abc",
  "taskId": "task-creative-upload-1",
  "artifacts": [{
    "name": "hero_video.mp4",
    "artifactId": "art-video-v1"
  }]
}

// Request variations (same context)
{
  "contextId": "ctx-campaign-abc",  // Same context
  "referenceTaskIds": ["task-creative-upload-1"],
  "message": "Create vertical version for mobile"
}

// Get new artifact in same context
{
  "contextId": "ctx-campaign-abc",
  "taskId": "task-creative-adapt-2",
  "artifacts": [{
    "name": "hero_video_vertical.mp4",
    "artifactId": "art-video-v2"
  }]
}
```

## Revised Architecture: A2A Core with MCP Adapter

```
┌─────────────────────────────────────────────┐
│           AdCP Agent (A2A-First)            │
├─────────────────────────────────────────────┤
│  ┌────────────────────────────────────────┐│
│  │          A2A Task Engine               ││
│  │  - Task lifecycle management           ││
│  │  - Context persistence                 ││
│  │  - Artifact handling                   ││
│  │  - Status streaming (SSE)              ││
│  └────────────────────────────────────────┘│
│                    │                        │
│  ┌─────────────────┴──────────────────┐   │
│  │      Core Business Logic           │   │
│  │  - Media Buy workflows             │   │
│  │  - Signal discovery                │   │
│  │  - Creative management             │   │
│  │  - HITL operations                 │   │
│  └─────────────────┬──────────────────┘   │
│                    │                        │
│  ┌────────────────┴───────────────────┐   │
│  │       MCP Compatibility Layer      │   │
│  │  - Translates tools to tasks       │   │
│  │  - Maintains backward compat       │   │
│  └────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

## Real-World AdCP Workflows as A2A Tasks

### Media Buy Creation with Natural Status Updates

```javascript
class MediaBuyTask {
  async execute(params, task) {
    // Update: Starting
    await task.update({
      status: { state: "working" },
      message: "Analyzing campaign requirements..."
    });

    // Check inventory
    await task.update({
      message: "Checking inventory availability across 5 platforms..."
    });
    const inventory = await this.checkInventory(params.brief);

    // Validate targeting
    await task.update({
      message: "Validating targeting parameters and compliance..."
    });
    const validation = await this.validateTargeting(params.targeting);

    if (validation.requiresApproval) {
      // Natural HITL state
      await task.update({
        status: { state: "pending_approval" },
        message: "Campaign requires compliance approval",
        metadata: {
          approvalType: "compliance",
          reason: validation.reason
        }
      });
      
      // Wait for approval (via webhook or polling)
      await this.waitForApproval(task.id);
    }

    // Create the buy
    await task.update({
      message: "Creating media buy in ad server..."
    });
    const mediaBuy = await this.createInAdServer(params);

    // Return with artifacts
    return {
      status: { state: "completed" },
      artifacts: [{
        name: "media_buy_confirmation",
        parts: [{
          kind: "application/json",
          data: mediaBuy
        }, {
          kind: "application/pdf",
          uri: mediaBuy.contractUrl
        }]
      }]
    };
  }
}
```

### Creative Workflow with Context

```javascript
// Task 1: Upload initial creative
{
  "method": "message/send",
  "params": {
    "message": {
      "parts": [{
        "kind": "text",
        "text": "Upload creative for pet food campaign"
      }, {
        "kind": "file",
        "uri": "https://cdn.example.com/pet_food_hero.mp4"
      }]
    }
  }
}

// Response: Task with context
{
  "taskId": "task-creative-001",
  "contextId": "ctx-petfood-campaign",
  "status": { "state": "completed" },
  "artifacts": [{
    "artifactId": "art-creative-v1",
    "name": "pet_food_hero.mp4"
  }]
}

// Task 2: Request adaptation (same context)
{
  "method": "message/send",
  "params": {
    "contextId": "ctx-petfood-campaign",  // Continue conversation
    "message": {
      "parts": [{
        "kind": "text",
        "text": "Create a 15-second version and add captions"
      }]
    }
  }
}

// Status updates via SSE
data: {"status": {"state": "working"}, "message": "Analyzing video content..."}
data: {"status": {"state": "working"}, "message": "Generating 15s cut..."}
data: {"status": {"state": "working"}, "message": "Adding captions..."}
data: {"status": {"state": "completed"}, "artifacts": [...]}
```

## MCP Compatibility Layer

For backward compatibility, we provide an MCP interface that translates to A2A tasks:

```javascript
class MCPCompatibilityLayer {
  async handleToolCall(tool, params) {
    // Create an A2A task
    const task = await this.a2aEngine.createTask({
      type: 'mcp_tool_call',
      tool: tool,
      params: params
    });

    // Wait for completion (blocking mode)
    const result = await task.waitForCompletion();

    // Return MCP-style response
    if (result.status.state === 'completed') {
      return this.extractMCPResponse(result.artifacts);
    } else {
      throw new Error(result.status.message);
    }
  }

  // Special handling for async operations
  async handleAsyncTool(tool, params) {
    const task = await this.a2aEngine.createTask({
      type: 'mcp_async_tool',
      tool: tool,
      params: params
    });

    // Return task ID for polling
    return {
      task_id: task.id,
      status: 'pending',
      poll_url: `/tasks/${task.id}/status`
    };
  }
}
```

## Benefits of A2A-First Architecture

### 1. Natural Workflow Representation
- Media buys naturally progress through states
- Creative workflows maintain context
- HITL is a first-class citizen

### 2. Better User Experience
- Real-time progress updates
- Clear status communication
- Contextual error handling

### 3. Simplified Implementation
- No need to build task management on top of MCP
- Status updates are built-in
- Artifact handling is native

### 4. Future-Proof
- Aligns with Google's vision for agent communication
- Supports complex multi-agent workflows
- Ready for advanced features like UI embedding

## Migration Strategy

### Phase 1: Internal A2A Implementation
- Build core workflows on A2A Task model
- Use contextId for campaign management
- Implement status streaming

### Phase 2: MCP Compatibility
- Add MCP adapter for existing clients
- Map tools to task types
- Provide polling for async operations

### Phase 3: Full A2A Exposure
- Expose native A2A endpoints
- Enable cross-agent collaboration
- Support advanced A2A features

## Example: Complete Media Buy Flow

```javascript
// 1. Start campaign planning
Client -> Agent: "Plan a $100K campaign for pet food"
Agent -> Client: taskId: "task-plan-001", status: "working"

// 2. Stream progress updates
SSE: "Analyzing market conditions..."
SSE: "Found 15 suitable products across 3 platforms"
SSE: "Optimizing budget allocation..."

// 3. Present plan (with artifact)
Agent -> Client: status: "completed", artifact: "campaign_plan.pdf"

// 4. Continue in same context
Client -> Agent: "Looks good, but increase CTV budget by 20%"
Agent -> Client: taskId: "task-plan-002", contextId: (same)

// 5. Execute with HITL
Client -> Agent: "Execute this plan"
Agent -> Client: status: "pending_approval", "Requires compliance review"

// 6. After approval
Agent -> Client: status: "completed", artifacts: [media_buy_ids]
```

This A2A-first approach makes AdCP workflows more natural, powerful, and future-proof while maintaining compatibility with existing MCP clients.