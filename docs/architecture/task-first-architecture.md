# Task-First Architecture for AdCP

## Core Insight

Instead of building on A2A or MCP, we build on a **Task abstraction** with protocol adapters. This separates business logic from protocol concerns and provides maximum flexibility.

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│              Protocol Layer                      │
├─────────────────────────────────────────────────┤
│  ┌─────────────┐         ┌─────────────┐       │
│  │ MCP Adapter │         │ A2A Adapter │       │
│  └──────┬──────┘         └──────┬──────┘       │
│         │                        │               │
│         └────────┬───────────────┘               │
│                  ▼                               │
├─────────────────────────────────────────────────┤
│           Task Engine (Core)                     │
├─────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────┐    │
│  │  Task Definition & Lifecycle            │    │
│  │  - States: pending|working|paused|done │    │
│  │  - Context management                   │    │
│  │  - Status updates                       │    │
│  │  - Artifact handling                    │    │
│  └────────────────────────────────────────┘    │
│                  ▼                               │
├─────────────────────────────────────────────────┤
│         Task Implementations                     │
├─────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌───────────────┐          │
│  │ MediaBuyTask │  │ CreativeTask  │          │
│  └──────────────┘  └───────────────┘          │
│  ┌──────────────┐  ┌───────────────┐          │
│  │ SignalsTask  │  │ ReportingTask │          │
│  └──────────────┘  └───────────────┘          │
└─────────────────────────────────────────────────┘
```

## Core Task Model

```typescript
interface Task {
  // Identity
  id: string;
  type: string;
  contextId: string;
  
  // State
  state: 'pending' | 'working' | 'paused' | 'pending_approval' | 
         'pending_input' | 'completed' | 'failed';
  
  // Progress
  progress?: {
    message: string;
    percentage?: number;
    metadata?: Record<string, any>;
  };
  
  // Results
  artifacts?: Artifact[];
  error?: TaskError;
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, any>;
}

interface TaskHandler {
  // Implement this to create a task
  async execute(input: TaskInput, context: TaskContext): Promise<void>;
  
  // Optional: Handle task-specific events
  async onPause?(context: TaskContext): Promise<void>;
  async onResume?(context: TaskContext): Promise<void>;
  async onCancel?(context: TaskContext): Promise<void>;
}

interface TaskContext {
  // Identity
  task: Task;
  
  // State management
  async updateStatus(message: string, metadata?: any): Promise<void>;
  async setState(state: Task['state']): Promise<void>;
  async setProgress(progress: number, message?: string): Promise<void>;
  
  // Human-in-the-loop
  async requestApproval(details: ApprovalRequest): Promise<void>;
  async waitForInput(prompt: InputRequest): Promise<any>;
  
  // Results
  async addArtifact(artifact: Artifact): Promise<void>;
  async complete(artifacts?: Artifact[]): Promise<void>;
  async fail(error: TaskError): Promise<void>;
  
  // Context
  async getContext<T>(key: string): Promise<T>;
  async setContext(key: string, value: any): Promise<void>;
}
```

## Example: Media Buy Task Implementation

```typescript
class MediaBuyTask implements TaskHandler {
  async execute(input: TaskInput, ctx: TaskContext) {
    // Parse input (protocol-agnostic)
    const params = this.parseParams(input);
    
    // Update status - protocol adapters handle delivery
    await ctx.updateStatus('Validating campaign parameters...');
    
    // Business logic
    const validation = await this.validateCampaign(params);
    
    if (validation.errors.length > 0) {
      return ctx.fail({
        code: 'VALIDATION_ERROR',
        message: 'Campaign validation failed',
        details: validation.errors
      });
    }
    
    // Check inventory
    await ctx.updateStatus('Checking inventory availability...');
    const inventory = await this.checkInventory(params);
    
    // Needs approval?
    if (params.budget > 100000 || validation.requiresApproval) {
      await ctx.setState('pending_approval');
      await ctx.requestApproval({
        type: 'budget_approval',
        reason: 'Campaign exceeds automatic approval threshold',
        details: {
          budget: params.budget,
          inventory: inventory.summary
        }
      });
      
      // Task engine handles waiting for approval
      // When resumed, we continue here
    }
    
    // Create campaign
    await ctx.updateStatus('Creating campaign in ad server...');
    await ctx.setProgress(75, 'Submitting to ad server');
    
    const campaign = await this.createInAdServer(params, inventory);
    
    // Add results
    await ctx.addArtifact({
      name: 'media_buy_confirmation',
      type: 'application/json',
      data: campaign
    });
    
    await ctx.addArtifact({
      name: 'insertion_order',
      type: 'application/pdf',
      uri: campaign.ioUrl
    });
    
    // Complete
    await ctx.complete();
  }
}
```

## Protocol Adapters

### MCP Adapter

```typescript
class MCPAdapter {
  constructor(private taskEngine: TaskEngine) {}
  
  // MCP tool call → Task
  async handleToolCall(tool: string, params: any): Promise<any> {
    // Map tool to task type
    const taskType = this.mapToolToTask(tool);
    
    // Create task
    const task = await this.taskEngine.createTask({
      type: taskType,
      input: params,
      options: {
        // MCP is synchronous by default
        waitForCompletion: true,
        timeout: 30000
      }
    });
    
    // For async operations, return task info
    if (this.isAsyncTool(tool)) {
      return {
        task_id: task.id,
        status: task.state,
        status_url: `/tasks/${task.id}`
      };
    }
    
    // For sync operations, wait and return result
    const result = await task.waitForCompletion();
    
    if (result.state === 'completed') {
      // Extract result from artifacts
      return this.extractResult(result.artifacts);
    } else {
      throw new Error(result.error?.message || 'Task failed');
    }
  }
  
  // Polling endpoint for async tasks
  async getTaskStatus(taskId: string): Promise<any> {
    const task = await this.taskEngine.getTask(taskId);
    return {
      status: task.state,
      progress: task.progress,
      result: task.state === 'completed' ? 
        this.extractResult(task.artifacts) : null
    };
  }
}
```

### A2A Adapter

```typescript
class A2AAdapter {
  constructor(private taskEngine: TaskEngine) {}
  
  // A2A message → Task
  async handleMessage(message: A2AMessage): Promise<A2AResponse> {
    const { contextId, referenceTaskIds } = message;
    
    // Determine task type from message
    const taskType = await this.inferTaskType(message);
    
    // Create or continue task
    const task = await this.taskEngine.createTask({
      type: taskType,
      contextId: contextId,
      input: {
        message: message.parts,
        referenceTaskIds
      }
    });
    
    // A2A expects immediate response with task info
    return {
      taskId: task.id,
      contextId: task.contextId,
      status: { state: this.mapTaskStateToA2A(task.state) }
    };
  }
  
  // Stream task updates via SSE
  async streamTaskUpdates(taskId: string, stream: EventStream) {
    const task = await this.taskEngine.getTask(taskId);
    
    // Subscribe to task events
    task.on('statusUpdate', (update) => {
      stream.send({
        type: 'status',
        data: {
          message: update.message,
          metadata: update.metadata
        }
      });
    });
    
    task.on('stateChange', (state) => {
      stream.send({
        type: 'state',
        data: { state: this.mapTaskStateToA2A(state) }
      });
    });
    
    task.on('complete', (artifacts) => {
      stream.send({
        type: 'complete',
        data: {
          artifacts: this.mapArtifactsToA2A(artifacts)
        }
      });
      stream.close();
    });
  }
}
```

## Benefits of Task-First Architecture

### 1. **Protocol Independence**
Implementers only need to understand the Task interface, not protocol specifics:
```typescript
// Developer implements this
class MyTask implements TaskHandler {
  async execute(input, ctx) {
    // Just focus on business logic
    await ctx.updateStatus('Doing something...');
    // ...
  }
}

// Framework handles protocol translation automatically
```

### 2. **Future-Proof**
Adding a new protocol is just adding a new adapter:
```typescript
class GraphQLAdapter {
  // Maps GraphQL subscriptions to task events
}

class WebSocketAdapter {
  // Real-time task updates over WebSocket
}
```

### 3. **Consistent Behavior**
All protocols get the same features:
- Status updates
- Progress tracking
- HITL support
- Context management
- Artifact handling

### 4. **Easier Testing**
Test tasks directly without protocol overhead:
```typescript
const task = new MediaBuyTask();
const ctx = new TestTaskContext();
await task.execute(input, ctx);
expect(ctx.artifacts).toHaveLength(2);
```

### 5. **Clean Separation of Concerns**
- **Task Layer**: Business logic only
- **Protocol Layer**: Translation only
- **Engine Layer**: State management, persistence, events

## Implementation Path

### Phase 1: Define Core Task Model
- Task interface and lifecycle
- Context management
- Event system
- Artifact handling

### Phase 2: Build Task Implementations
- MediaBuyTask
- CreativeTask
- SignalsTask
- ReportingTask

### Phase 3: Add Protocol Adapters
- MCP adapter (for compatibility)
- A2A adapter (for rich features)
- REST adapter (for simple integrations)

### Phase 4: Advanced Features
- Task composition (workflows)
- Task dependencies
- Parallel execution
- Retry policies

## Example: Complete Flow

```typescript
// 1. A2A Request comes in
POST /a2a
{
  "method": "message/send",
  "params": {
    "message": {
      "parts": [{"text": "Create $50K CTV campaign"}]
    }
  }
}

// 2. A2A Adapter creates task
const task = taskEngine.createTask({
  type: 'media_buy',
  input: { brief: "Create $50K CTV campaign" }
});

// 3. MediaBuyTask executes
// - Updates status
// - Requests approval if needed
// - Creates campaign
// - Returns artifacts

// 4. A2A Adapter streams updates
SSE: {"message": "Checking inventory..."}
SSE: {"message": "Pending approval..."}
SSE: {"state": "completed", "artifacts": [...]}

// Same task works with MCP!
POST /mcp
{
  "method": "create_media_buy",
  "params": { "budget": 50000, "type": "ctv" }
}
// Returns when complete or task_id if async
```

## Conclusion

A task-first architecture provides:
- **Clean abstraction** for implementers
- **Protocol flexibility** for clients  
- **Future-proofing** for new standards
- **Consistent features** across protocols
- **Simpler implementation** overall

Instead of choosing between MCP and A2A, we get both—plus the ability to add more protocols as needed—all while keeping the implementation clean and focused on business logic.