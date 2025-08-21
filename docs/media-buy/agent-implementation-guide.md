---
title: Agent Implementation Guide
---

# Media Buy Implementation Guide for Coding Agents

This guide provides step-by-step instructions for coding agents implementing the AdCP Media Buy specification. You can implement AdCP using either **MCP** (Model Context Protocol) or **A2A** (Agent2Agent) protocol - both are first-class, fully-supported options.

## Choose Your Protocol

### Option 1: MCP (Model Context Protocol)
**Best for:**
- Direct AI assistant integration
- Simple request/response workflows
- Synchronous operations with polling for async

### Option 2: A2A (Agent2Agent)
**Best for:**
- Complex multi-step workflows
- Native async with real-time updates (SSE)
- Built-in human-in-the-loop support
- Rich context management

## Quick Start Checklist

```markdown
## Implementation Progress
- [ ] Choose protocol: MCP or A2A
- [ ] Set up server foundation (MCP or A2A)
- [ ] Implement get_products task
- [ ] Implement list_creative_formats task
- [ ] Implement create_media_buy task
- [ ] Implement add_creative_assets task
- [ ] Implement get_media_buy_delivery task
- [ ] Implement update_media_buy task
- [ ] Add error handling for all tasks
- [ ] Implement async operation handling
- [ ] Add human-in-the-loop support
- [ ] Test with reference client
```

## Prerequisites

Before implementing, ensure you have:
1. Read the [Media Buy Overview](./index.md)
2. Choose your protocol and understand it:
   - [MCP Protocol Guide](../protocols/mcp.md) - for MCP implementations
   - [A2A Protocol Guide](../protocols/a2a.md) - for A2A implementations
   - [Protocol Overview](../protocols/overview.md) - comparison and selection guide
3. Reviewed the [API Reference](./api-reference.md)
4. Studied the [Design Decisions](./design-decisions.md) for architectural guidance
5. Reviewed the [Orchestrator Design Guide](./orchestrator-design.md) for async patterns

## Key Lessons from Reference Implementations

### 🎯 Critical Design Patterns

Based on our experience building reference implementations, these patterns are essential:

1. **Asynchronous-First Architecture**
   - Operations can take seconds to days - never assume immediate completion
   - Pending states (`pending_manual`, `pending_approval`) are NORMAL, not errors
   - Implement proper state machines for all operations
   - Store operation state persistently, not just in memory

2. **Message Field Pattern**
   - ALWAYS include a human-readable `message` field as the first field in responses
   - This allows AI agents to understand responses without parsing JSON
   - Example: `{"message": "Created $50K campaign targeting pet owners...", ...}`

3. **Context Persistence**
   - Use `context_id` to maintain state across interactions
   - First request: `context_id: null`
   - Server creates context and returns it
   - Subsequent requests include the context_id

4. **PATCH Semantics for Updates**
   - Updates modify ONLY included fields, not replace-all
   - This prevents accidental data loss
   - Example: Updating package budget doesn't affect targeting

5. **Natural Language First**
   - Accept natural language briefs in discovery (`get_products`)
   - Design for AI agents, not traditional APIs
   - Fuzzy matching is better than exact matching

## Implementation Order

Follow this sequence for the smoothest implementation path:

### Phase 1: Foundation (Start Here)

#### 1. Set Up Your Server

<details>
<summary><b>MCP Implementation</b></summary>

```typescript
// MCP server setup
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({
  name: "adcp-media-buy-server",
  version: "1.0.0"
});

// Register tasks as MCP tools
server.setRequestHandler(TaskRequestSchema, handleTaskRequest);

// MCP tools are synchronous by default
// Return task_id for async operations
```
</details>

<details>
<summary><b>A2A Implementation</b></summary>

```typescript
// A2A server setup
import { A2AServer } from "@google/agent2agent";

const server = new A2AServer({
  name: "AdCP Media Buy Agent",
  version: "1.0.0",
  capabilities: {
    adcp_compliant: true,
    standard_tasks: [
      "get_products",
      "create_media_buy",
      "add_creative_assets"
    ]
  }
});

// Register message handler
server.on('message', async (context, message) => {
  return await handleA2AMessage(context, message);
});

// A2A is async-native with SSE updates
server.enableSSE();
```
</details>

#### 2. Define Core Data Models
```typescript
// Essential types to implement first
interface Product {
  id: string;
  name: string;
  description: string;
  publisher: Publisher;
  dimensions: Dimensions;
  pricing: Pricing;
  // ... see media-products.md for full schema
}

interface MediaBuy {
  id: string;
  status: "pending" | "active" | "paused" | "completed";
  brief: Brief;
  packages: Package[];
  // ... see media-buys.md for full schema
}
```

### Phase 2: Discovery Tasks

#### 3. Implement `get_products`
**Purpose**: Allow agents to discover available inventory

**Key Implementation Points**:
- Parse the natural language brief
- Match products based on dimensions
- Return filtered, relevant products
- Include clear pricing and availability

**Common Pitfalls**:
- ❌ Don't include internal fields like `targeting_template`
- ❌ Don't require exact dimension matches - use fuzzy matching
- ✅ Do include all products that partially match the brief
- ✅ Do sort by relevance score

<details>
<summary><b>MCP Implementation</b></summary>

```typescript
// MCP: Direct tool call with immediate response
async function handleGetProducts(params: GetProductsParams): Promise<GetProductsResponse> {
  // Parse natural language brief
  const requirements = parseBrief(params.brief);
  
  // Query and filter inventory
  const allProducts = await queryInventory();
  const matches = filterAndScore(allProducts, requirements);
  
  // Return with message field pattern
  return {
    message: `Found ${matches.length} products matching your brief`,
    context_id: params.context_id || generateContextId(),
    products: matches
  };
}

// Register as MCP tool
server.addTool({
  name: "get_products",
  description: "Discover advertising products",
  handler: handleGetProducts
});
```
</details>

<details>
<summary><b>A2A Implementation</b></summary>

```typescript
// A2A: Task-based with streaming updates
async function handleGetProducts(context: Context, message: Message) {
  const taskId = generateTaskId();
  
  // Send immediate acknowledgment
  await context.sendStatus({
    taskId,
    state: "working",
    message: "Analyzing your requirements..."
  });
  
  // Parse brief from message
  const brief = extractBrief(message);
  const requirements = parseBrief(brief);
  
  // Stream progress updates
  await context.sendStatus({
    taskId,
    state: "working",
    message: "Searching inventory..."
  });
  
  const allProducts = await queryInventory();
  const matches = filterAndScore(allProducts, requirements);
  
  // Return as artifact with message
  return {
    status: { state: "completed" },
    message: `Found ${matches.length} products matching your brief`,
    contextId: context.id || generateContextId(),
    artifacts: [{
      name: "products",
      parts: [{
        kind: "application/json",
        data: { products: matches }
      }]
    }]
  };
}
```
</details>
```

#### 4. Implement `list_creative_formats`
**Purpose**: Show what creative types are supported

**Key Implementation Points**:
- Return all supported formats
- Include clear specifications
- Group by media type (display, video, audio)
- Include validation rules

```typescript
async function handleListCreativeFormats(): Promise<CreativeFormat[]> {
  return [
    {
      id: "display_standard",
      name: "Standard Display",
      media_type: "display",
      specifications: {
        sizes: ["300x250", "728x90", "320x50"],
        file_types: ["jpg", "png", "gif"],
        max_file_size_kb: 150
      }
    },
    // ... more formats
  ];
}
```

### Phase 3: Campaign Creation

#### 5. Implement `create_media_buy`
**Purpose**: Create campaigns from selected products

**Key Implementation Points**:
- Validate package selections
- Apply targeting overlays correctly
- Handle budget allocation
- Return immediate or pending status
- Generate unique media_buy_id

<details>
<summary><b>MCP Implementation</b></summary>

```typescript
// MCP: Return task_id for async operations
async function handleCreateMediaBuy(params: CreateMediaBuyParams): Promise<CreateMediaBuyResponse> {
  // Validate request
  validatePackages(params.packages);
  validateBudget(params.packages);
  
  // 2. Create the media buy with proper status handling
  const requiresApproval = await checkIfRequiresApproval(params);
  const mediaBuy = {
    id: generateUniqueId(),
    // LESSON: Pending states are normal workflow, not errors!
    status: requiresApproval ? "pending_manual" : "pending_activation",
    created_at: new Date().toISOString(),
    brief: params.brief,
    packages: params.packages,
    // ... other fields
  };
  
  // 3. Store in database
  await saveMediaBuy(mediaBuy);
  
  // 4. Handle async processing if needed
  if (mediaBuy.status === "pending_manual") {
    // Create HITL task for manual approval
    const taskId = await createApprovalTask(mediaBuy);
    
    return {
      message: "Media buy requires publisher approval. This typically takes 2-4 hours.",
      context_id: params.context_id || generateContextId(),
      status: "pending_manual",
      task_id: taskId,
      detail: `Manual approval required. Task ID: ${taskId}`
    };
  }
  
  // Normal flow - awaiting creatives
  return {
    message: `Created media buy with ${params.packages.length} packages. Upload creatives by ${mediaBuy.creative_deadline}`,
    context_id: params.context_id || generateContextId(),
    media_buy_id: mediaBuy.id,
    status: "pending_activation",
    creative_deadline: mediaBuy.creative_deadline
  };
}
```
</details>

<details>
<summary><b>A2A Implementation</b></summary>

```typescript
// A2A: Native async with real-time updates
async function handleCreateMediaBuy(context: Context, message: Message) {
  const taskId = generateTaskId();
  
  // Extract parameters from message
  const params = extractMediaBuyParams(message);
  
  // Send immediate acknowledgment
  await context.sendStatus({
    taskId,
    state: "working",
    message: "Validating campaign parameters..."
  });
  
  // Validate request
  validatePackages(params.packages);
  validateBudget(params.packages);
  
  // Stream progress
  await context.sendStatus({
    taskId,
    state: "working",
    message: "Checking inventory availability..."
  });
  
  const requiresApproval = await checkIfRequiresApproval(params);
  
  if (requiresApproval) {
    // A2A handles HITL natively
    await context.sendStatus({
      taskId,
      state: "pending_approval",
      metadata: {
        approvalType: "budget_approval",
        reason: "Exceeds automatic approval threshold"
      },
      message: "Campaign requires publisher approval (typically 2-4 hours)"
    });
    
    // Wait for approval in same context
    const approval = await context.waitForApproval();
    
    if (approval.approved) {
      await context.sendStatus({
        taskId,
        state: "working",
        message: "Approval received, creating campaign..."
      });
    } else {
      return {
        status: { state: "failed" },
        message: `Campaign rejected: ${approval.reason}`
      };
    }
  }
  
  // Create the media buy
  const mediaBuy = await createMediaBuy(params);
  
  // Return as artifact
  return {
    status: { state: "completed" },
    message: `Created media buy with ${params.packages.length} packages`,
    contextId: context.id,
    artifacts: [{
      name: "media_buy_confirmation",
      parts: [{
        kind: "application/json",
        data: {
          media_buy_id: mediaBuy.id,
          status: "pending_activation",
          creative_deadline: mediaBuy.creative_deadline
        }
      }]
    }]
  };
}
```
</details>

#### 6. Implement `add_creative_assets`
**Purpose**: Attach creatives to campaigns

**Key Implementation Points**:
- Validate creative formats
- Handle file uploads or URLs
- Support batch operations
- Track approval status

```typescript
async function handleAddCreativeAssets(params: AddCreativeAssetsParams): Promise<void> {
  // 1. Validate media buy exists
  const mediaBuy = await getMediaBuy(params.media_buy_id);
  
  // 2. Process each asset
  for (const asset of params.assets) {
    // Validate format matches requirements
    validateAssetFormat(asset, mediaBuy.creative_requirements);
    
    // Store or reference the asset
    await storeCreativeAsset(mediaBuy.id, asset);
  }
  
  // 3. Update media buy status if needed
  await updateMediaBuyCreativeStatus(mediaBuy.id);
}
```

### Phase 4: Monitoring & Optimization

#### 7. Implement `get_media_buy_delivery`
**Purpose**: Provide performance data

**Key Implementation Points**:
- Aggregate metrics across platforms
- Handle date ranges properly
- Include pacing information
- Provide optimization signals

```typescript
async function handleGetMediaBuyDelivery(params: GetDeliveryParams): Promise<Delivery> {
  // 1. Fetch raw metrics
  const metrics = await fetchMetrics(params.media_buy_id, params.date_range);
  
  // 2. Calculate pacing
  const pacing = calculatePacing(metrics, mediaBuy.budget, mediaBuy.flight_dates);
  
  // 3. Generate insights
  const insights = generateOptimizationInsights(metrics, pacing);
  
  return {
    metrics,
    pacing,
    insights,
    last_updated: new Date().toISOString()
  };
}
```

#### 8. Implement `update_media_buy`
**Purpose**: Allow campaign modifications

**Key Implementation Points**:
- Support partial updates
- Validate changes don't break invariants
- Handle in-flight campaigns carefully
- Maintain audit trail

## Async Operation Handling (Critical!)

⚠️ **LESSON LEARNED**: The entire protocol is built around async operations. This is not optional - it's the core of AdCP.

Many AdCP operations are asynchronous and can take hours or days. Both protocols handle this differently:

### MCP Async Handling
MCP requires polling or webhooks for async operations:

```typescript
// MCP: Return task_id for polling
if (isAsyncOperation) {
  return {
    task_id: "task_123",
    status: "pending",
    poll_url: "/tasks/task_123",
    message: "Operation in progress, poll for updates"
  };
}

// Client polls for completion
const pollTask = async (taskId) => {
  let status;
  do {
    await sleep(5000);
    status = await fetch(`/tasks/${taskId}`);
  } while (status.state === 'pending');
  return status;
};
```

### A2A Async Handling
A2A provides native async with SSE:

```typescript
// A2A: Real-time updates via SSE
await context.sendStatus({
  taskId,
  state: "working",
  message: "Processing your request..."
});

// Client receives updates automatically
const events = new EventSource('/a2a/tasks/task_123/events');
events.onmessage = (event) => {
  const update = JSON.parse(event.data);
  console.log(update.message);
};
```

### Common Async Patterns

```typescript
class AsyncOperationManager {
  async trackOperation(mediaBuyId: string, operation: string) {
    // Store operation state
    await db.operations.create({
      media_buy_id: mediaBuyId,
      operation,
      status: "pending",
      created_at: Date.now()
    });
    
    // Return immediately to client
    return { status: "pending", operation_id: generateId() };
  }
  
  async completeOperation(operationId: string, result: any) {
    // Update operation status
    await db.operations.update(operationId, {
      status: "completed",
      result,
      completed_at: Date.now()
    });
    
    // Notify waiting clients if applicable
    await notifyClients(operationId, result);
  }
}
```

## Human-in-the-Loop Support

**LESSON LEARNED**: Publishers often require manual approval. This is a FEATURE, not a bug. Design your system to handle pending states gracefully.

### MCP HITL Implementation
MCP requires custom HITL handling:

```typescript
class MCPHumanInTheLoop {
  async requiresApproval(mediaBuy: MediaBuy): Promise<boolean> {
    return mediaBuy.total_budget > 10000;
  }
  
  async submitForApproval(mediaBuy: MediaBuy): Promise<string> {
    const taskId = generateTaskId();
    
    // Create approval task
    await createApprovalTask({
      task_id: taskId,
      type: "media_buy_approval",
      media_buy_id: mediaBuy.id
    });
    
    // Return error with task info for polling
    throw {
      error: {
        code: "PENDING_APPROVAL",
        message: "Requires manual approval",
        task_id: taskId,
        poll_url: `/tasks/${taskId}`
      }
    };
  }
}
```

### A2A HITL Implementation
A2A has native HITL support:

```typescript
class A2AHumanInTheLoop {
  async handleApproval(context: Context, mediaBuy: MediaBuy) {
    // Enter pending state
    await context.sendStatus({
      state: "pending_approval",
      metadata: {
        approvalType: "budget_approval",
        mediaBuyId: mediaBuy.id
      }
    });
    
    // Wait for approval in same context
    const approval = await context.waitForApproval();
    
    if (approval.approved) {
      // Continue processing
      await context.sendStatus({
        state: "working",
        message: "Approval received, continuing..."
      });
    } else {
      // Handle rejection
      throw new Error(`Rejected: ${approval.reason}`);
    }
  }
}
```

### Common HITL Patterns

```typescript
interface ApprovalWorkflow {
  async requiresApproval(mediaBuy: MediaBuy): Promise<boolean> {
    // Check if manual approval needed
    return mediaBuy.total_budget > 10000 || 
           mediaBuy.requires_review ||
           hasRestrictedTargeting(mediaBuy);
  }
  
  async submitForApproval(mediaBuy: MediaBuy): Promise<void> {
    // Create approval task
    await createApprovalTask({
      type: "media_buy_approval",
      media_buy_id: mediaBuy.id,
      assigned_to: getApprover(mediaBuy),
      due_date: calculateDueDate(mediaBuy.flight_dates)
    });
    
    // Update status
    await updateMediaBuyStatus(mediaBuy.id, "pending_approval");
  }
}
```

## Error Handling

### Comprehensive Error Strategy

**LESSON LEARNED**: Robust error handling is critical for AI agents to understand and recover from failures.

<details>
<summary><b>MCP Error Handling</b></summary>

```typescript
// MCP: Comprehensive error handling with retry hints
class MCPErrorHandler {
  private static ERROR_CODES = {
    // Client errors (4xx equivalent)
    INVALID_REQUEST: { code: "invalid_request", retryable: false },
    PRODUCT_NOT_FOUND: { code: "product_not_found", retryable: false },
    INSUFFICIENT_BUDGET: { code: "insufficient_budget", retryable: false },
    CREATIVE_VALIDATION_FAILED: { code: "creative_validation_failed", retryable: false },
    RATE_LIMITED: { code: "rate_limited", retryable: true, defaultRetryAfter: 60 },
    
    // Server errors (5xx equivalent)
    INTERNAL_ERROR: { code: "internal_error", retryable: true, defaultRetryAfter: 5 },
    SERVICE_UNAVAILABLE: { code: "service_unavailable", retryable: true, defaultRetryAfter: 30 },
    TIMEOUT: { code: "timeout", retryable: true, defaultRetryAfter: 10 }
  };

  static formatError(error: any, context?: any): MCPError {
    // CRITICAL: Always include a human-readable message first
    let errorConfig = this.ERROR_CODES.INTERNAL_ERROR;
    let message = "An unexpected error occurred";
    let details = {};

    // Map known errors
    if (error instanceof ValidationError) {
      errorConfig = this.ERROR_CODES.INVALID_REQUEST;
      message = `Validation failed: ${error.message}`;
      details = { validation_errors: error.errors };
    } else if (error instanceof RateLimitError) {
      errorConfig = this.ERROR_CODES.RATE_LIMITED;
      message = `Rate limit exceeded. Please retry after ${error.retryAfter}s`;
      details = { retry_after: error.retryAfter };
    } else if (error instanceof TimeoutError) {
      errorConfig = this.ERROR_CODES.TIMEOUT;
      message = `Operation timed out after ${error.timeout}ms`;
    }

    return {
      error: {
        code: errorConfig.code,
        message: message,
        details: {
          ...details,
          request_id: context?.requestId || generateRequestId(),
          timestamp: new Date().toISOString()
        },
        retryable: errorConfig.retryable,
        retry_after: details.retry_after || errorConfig.defaultRetryAfter
      }
    };
  }

  // Wrap async operations with error handling
  static async withErrorHandling<T>(
    operation: () => Promise<T>,
    context?: any
  ): Promise<T | MCPError> {
    try {
      return await operation();
    } catch (error) {
      console.error(`Operation failed:`, error);
      return this.formatError(error, context);
    }
  }
}

// Usage in MCP tool handler
async function handleGetProducts(params: GetProductsParams) {
  return MCPErrorHandler.withErrorHandling(async () => {
    // Validate input first
    if (!params.brief && !params.filters) {
      throw new ValidationError("Either 'brief' or 'filters' must be provided");
    }
    
    // Your implementation
    const products = await discoverProducts(params);
    
    if (products.length === 0) {
      // Not an error - valid empty result
      return {
        message: "No products match your criteria. Try broadening your search.",
        context_id: params.context_id || generateContextId(),
        products: []
      };
    }
    
    return {
      message: `Found ${products.length} products matching your criteria`,
      context_id: params.context_id || generateContextId(),
      products: products
    };
  }, { requestId: params.request_id });
}
```
</details>

<details>
<summary><b>A2A Error Handling</b></summary>

```typescript
// A2A: Error handling with status updates
class A2AErrorHandler {
  private agent: A2AAgent;
  
  constructor(agent: A2AAgent) {
    this.agent = agent;
  }

  async handleTaskError(
    error: any,
    context: Context,
    message: Message
  ): Promise<TaskResult> {
    // Send error status update immediately
    await this.agent.sendStatus({
      state: "failed",
      message: this.getErrorMessage(error),
      metadata: {
        error_code: this.getErrorCode(error),
        retryable: this.isRetryable(error),
        details: this.getErrorDetails(error)
      }
    });

    // Log for debugging
    console.error(`Task ${message.task} failed:`, error);

    // Return structured error result
    return {
      status: {
        state: "failed",
        message: this.getErrorMessage(error)
      },
      error: {
        code: this.getErrorCode(error),
        message: this.getErrorMessage(error),
        retryable: this.isRetryable(error),
        retry_after: this.getRetryAfter(error)
      }
    };
  }

  private getErrorMessage(error: any): string {
    // CRITICAL: Always provide clear, actionable error messages
    if (error instanceof ValidationError) {
      return `Input validation failed: ${error.message}. Please check your parameters.`;
    }
    if (error instanceof AuthError) {
      return "Authentication failed. Please verify your credentials.";
    }
    if (error instanceof RateLimitError) {
      return `Rate limit exceeded. Please wait ${error.retryAfter}s before retrying.`;
    }
    return "An unexpected error occurred. Our team has been notified.";
  }

  private isRetryable(error: any): boolean {
    // Client errors (4xx) are generally not retryable
    if (error instanceof ValidationError || 
        error instanceof AuthError ||
        error instanceof NotFoundError) {
      return false;
    }
    // Server errors (5xx) and rate limits are retryable
    return true;
  }

  // Wrap operations with automatic status updates
  async withErrorHandling<T>(
    operation: () => Promise<T>,
    taskName: string
  ): Promise<T> {
    try {
      await this.agent.sendStatus({
        state: "in_progress",
        message: `Processing ${taskName}...`
      });
      
      const result = await operation();
      
      await this.agent.sendStatus({
        state: "completed",
        message: `Successfully completed ${taskName}`
      });
      
      return result;
    } catch (error) {
      await this.agent.sendStatus({
        state: "failed",
        message: this.getErrorMessage(error)
      });
      throw error;
    }
  }
}
```
</details>

### Rate Limiting and Retry Logic

**LESSON LEARNED**: Implement exponential backoff and respect rate limits to ensure reliable operations.

```typescript
class RetryHandler {
  private static DEFAULT_MAX_RETRIES = 3;
  private static DEFAULT_BASE_DELAY = 1000; // 1 second
  
  static async withRetry<T>(
    operation: () => Promise<T>,
    options: {
      maxRetries?: number;
      baseDelay?: number;
      shouldRetry?: (error: any) => boolean;
      onRetry?: (attempt: number, error: any) => void;
    } = {}
  ): Promise<T> {
    const maxRetries = options.maxRetries || this.DEFAULT_MAX_RETRIES;
    const baseDelay = options.baseDelay || this.DEFAULT_BASE_DELAY;
    const shouldRetry = options.shouldRetry || ((error) => error.retryable !== false);
    
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        
        if (attempt === maxRetries || !shouldRetry(error)) {
          throw error;
        }
        
        // Calculate delay with exponential backoff and jitter
        const delay = this.calculateDelay(baseDelay, attempt, error);
        
        if (options.onRetry) {
          options.onRetry(attempt, error);
        }
        
        console.log(`Retry attempt ${attempt}/${maxRetries} after ${delay}ms`);
        await this.sleep(delay);
      }
    }
    
    throw lastError;
  }
  
  private static calculateDelay(
    baseDelay: number,
    attempt: number,
    error: any
  ): number {
    // Honor server-specified retry delay if available
    if (error.retry_after) {
      return error.retry_after * 1000;
    }
    
    // Exponential backoff with jitter
    const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 1000; // 0-1 second jitter
    
    return Math.min(exponentialDelay + jitter, 60000); // Cap at 60 seconds
  }
  
  private static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Usage example
const products = await RetryHandler.withRetry(
  () => getProducts({ brief: "luxury watches" }),
  {
    maxRetries: 3,
    onRetry: (attempt, error) => {
      console.log(`Attempt ${attempt} failed: ${error.message}`);
    }
  }
);
```

## Testing Your Implementation

### Comprehensive Testing Strategy

**LESSON LEARNED**: Test not just happy paths but also edge cases, error conditions, and async behaviors.

### 1. Unit Test Each Task

<details>
<summary><b>Core Task Tests</b></summary>

```typescript
// Test suite for get_products
describe("get_products", () => {
  // Happy path tests
  it("should return products matching natural language brief", async () => {
    const result = await handleGetProducts({
      brief: "I need to reach millennials in California interested in fitness"
    });
    
    expect(result.message).toContain("Found");
    expect(result.products).toBeInstanceOf(Array);
    expect(result.products.length).toBeGreaterThan(0);
    expect(result.context_id).toBeDefined();
    
    // Validate product structure
    const product = result.products[0];
    expect(product).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      platform: expect.any(String),
      dimensions: expect.objectContaining({
        targeting: expect.any(Object),
        pricing: expect.any(Object)
      })
    });
  });

  it("should handle empty results gracefully", async () => {
    const result = await handleGetProducts({
      brief: "Ultra-specific criteria that matches nothing"
    });
    
    expect(result.message).toContain("No products match");
    expect(result.products).toEqual([]);
    expect(result.context_id).toBeDefined();
  });

  // Error cases
  it("should reject requests without brief or filters", async () => {
    const result = await handleGetProducts({});
    
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe("invalid_request");
    expect(result.error.message).toContain("brief" || "filters");
  });

  // Context preservation
  it("should preserve context across requests", async () => {
    const firstResult = await handleGetProducts({
      brief: "Sports advertising"
    });
    
    const secondResult = await handleGetProducts({
      brief: "Refine to basketball only",
      context_id: firstResult.context_id
    });
    
    expect(secondResult.context_id).toBe(firstResult.context_id);
    expect(secondResult.message).toContain("basketball");
  });
});

// Test suite for create_media_buy
describe("create_media_buy", () => {
  let testProducts: Product[];
  
  beforeEach(async () => {
    // Set up test products
    const result = await handleGetProducts({ brief: "Test products" });
    testProducts = result.products;
  });

  it("should create media buy with valid packages", async () => {
    const result = await handleCreateMediaBuy({
      name: "Test Campaign",
      packages: [{
        product_id: testProducts[0].id,
        budget: 10000,
        flight_dates: {
          start: "2024-01-01",
          end: "2024-01-31"
        }
      }]
    });
    
    expect(result.message).toContain("Created");
    expect(result.media_buy_id).toBeDefined();
    expect(result.status).toBe("draft");
  });

  it("should handle async approval workflow", async () => {
    const result = await handleCreateMediaBuy({
      name: "Large Budget Campaign",
      packages: [{
        product_id: testProducts[0].id,
        budget: 1000000 // Large budget triggers approval
      }]
    });
    
    expect(result.status).toBe("pending_approval");
    expect(result.approval_url).toBeDefined();
    expect(result.message).toContain("approval");
  });

  it("should validate budget constraints", async () => {
    const result = await handleCreateMediaBuy({
      name: "Under Budget Campaign",
      packages: [{
        product_id: testProducts[0].id,
        budget: 10 // Below minimum
      }]
    });
    
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe("insufficient_budget");
    expect(result.error.details.minimum_budget).toBeDefined();
  });
});
```
</details>

### 2. Integration Test the Workflow

<details>
<summary><b>End-to-End Workflow Tests</b></summary>

```typescript
describe("Complete Media Buy Workflow", () => {
  let contextId: string;
  let mediaBuyId: string;
  
  it("should execute full campaign creation workflow", async () => {
    // Step 1: Product Discovery
    console.log("Step 1: Discovering products...");
    const productsResult = await handleGetProducts({
      brief: "I want to reach tech professionals in major US cities"
    });
    
    expect(productsResult.products.length).toBeGreaterThan(0);
    contextId = productsResult.context_id;
    
    // Step 2: Check Creative Requirements
    console.log("Step 2: Checking creative formats...");
    const formatsResult = await handleListCreativeFormats({
      product_ids: productsResult.products.map(p => p.id),
      context_id: contextId
    });
    
    expect(formatsResult.formats).toBeDefined();
    
    // Step 3: Create Media Buy
    console.log("Step 3: Creating media buy...");
    const mediaBuyResult = await handleCreateMediaBuy({
      name: "Tech Professional Campaign Q1 2024",
      packages: productsResult.products.slice(0, 2).map(product => ({
        product_id: product.id,
        budget: 25000,
        flight_dates: {
          start: "2024-01-15",
          end: "2024-03-15"
        },
        targeting_adjustments: {
          age_range: { min: 25, max: 45 },
          interests: ["technology", "software", "startups"]
        }
      })),
      context_id: contextId
    });
    
    expect(mediaBuyResult.media_buy_id).toBeDefined();
    mediaBuyId = mediaBuyResult.media_buy_id;
    
    // Step 4: Add Creative Assets
    console.log("Step 4: Adding creative assets...");
    const creativesResult = await handleAddCreativeAssets({
      media_buy_id: mediaBuyId,
      assets: formatsResult.formats[0].required_assets.map(spec => ({
        name: spec.name,
        type: spec.type,
        url: `https://cdn.example.com/test-${spec.name}.${spec.type}`,
        metadata: {
          dimensions: spec.dimensions,
          duration: spec.duration,
          file_size: 1024000
        }
      })),
      context_id: contextId
    });
    
    expect(creativesResult.validation_status).toBe("passed");
    
    // Step 5: Activate Campaign
    console.log("Step 5: Activating campaign...");
    const updateResult = await handleUpdateMediaBuy({
      media_buy_id: mediaBuyId,
      status: "active",
      context_id: contextId
    });
    
    expect(updateResult.status).toBe("active");
    
    // Step 6: Check Delivery
    console.log("Step 6: Checking delivery...");
    const deliveryResult = await handleGetMediaBuyDelivery({
      media_buy_id: mediaBuyId,
      context_id: contextId
    });
    
    expect(deliveryResult.overall_status).toBe("active");
    expect(deliveryResult.packages).toBeDefined();
  }, 30000); // 30 second timeout for full workflow
});
```
</details>

### 3. Test Error Scenarios and Edge Cases

<details>
<summary><b>Error and Edge Case Tests</b></summary>

```typescript
describe("Error Handling and Edge Cases", () => {
  // Network and timeout handling
  it("should handle network timeouts gracefully", async () => {
    jest.spyOn(global, 'fetch').mockImplementation(() => 
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Network timeout')), 100)
      )
    );
    
    const result = await handleGetProducts({ brief: "test" });
    
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe("timeout");
    expect(result.error.retryable).toBe(true);
    expect(result.error.retry_after).toBeDefined();
  });

  // Rate limiting
  it("should handle rate limiting with proper backoff", async () => {
    const attempts: number[] = [];
    
    const mockHandler = jest.fn()
      .mockRejectedValueOnce({ code: "rate_limited", retry_after: 1 })
      .mockRejectedValueOnce({ code: "rate_limited", retry_after: 2 })
      .mockResolvedValue({ products: [] });
    
    const result = await RetryHandler.withRetry(
      mockHandler,
      {
        onRetry: (attempt) => attempts.push(attempt)
      }
    );
    
    expect(attempts).toEqual([1, 2]);
    expect(mockHandler).toHaveBeenCalledTimes(3);
  });

  // Invalid data handling
  it("should validate and reject malformed creative assets", async () => {
    const result = await handleAddCreativeAssets({
      media_buy_id: "test_id",
      assets: [{
        name: "Invalid Asset",
        type: "invalid_type",
        url: "not-a-valid-url"
      }]
    });
    
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe("creative_validation_failed");
    expect(result.error.details.validation_errors).toContain("invalid_type");
  });

  // Concurrent request handling
  it("should handle concurrent requests correctly", async () => {
    const requests = Array(10).fill(null).map((_, i) => 
      handleGetProducts({ brief: `Test brief ${i}` })
    );
    
    const results = await Promise.all(requests);
    
    expect(results).toHaveLength(10);
    results.forEach(result => {
      expect(result.context_id).toBeDefined();
      expect(result.message).toBeDefined();
    });
  });

  // State consistency
  it("should maintain state consistency during updates", async () => {
    const mediaBuyId = "test_media_buy_123";
    
    // Simulate concurrent updates
    const update1 = handleUpdateMediaBuy({
      media_buy_id: mediaBuyId,
      packages: [{ package_id: "pkg1", budget: 5000 }]
    });
    
    const update2 = handleUpdateMediaBuy({
      media_buy_id: mediaBuyId,
      targeting: { geo: ["US-CA"] }
    });
    
    const results = await Promise.all([update1, update2]);
    
    // Both updates should succeed without conflict
    expect(results[0].error).toBeUndefined();
    expect(results[1].error).toBeUndefined();
    
    // Verify final state includes both updates
    const finalState = await handleGetMediaBuyDelivery({
      media_buy_id: mediaBuyId
    });
    
    expect(finalState.packages[0].budget).toBe(5000);
    expect(finalState.targeting.geo).toContain("US-CA");
  });
});
```
</details>

### 4. Performance and Load Testing

```typescript
describe("Performance Tests", () => {
  it("should handle high-volume product discovery", async () => {
    const startTime = Date.now();
    
    const result = await handleGetProducts({
      brief: "All available inventory",
      max_results: 1000
    });
    
    const duration = Date.now() - startTime;
    
    expect(duration).toBeLessThan(5000); // Should complete within 5s
    expect(result.products.length).toBeLessThanOrEqual(1000);
  });
  
  it("should efficiently batch creative validations", async () => {
    const assets = Array(100).fill(null).map((_, i) => ({
      name: `Asset ${i}`,
      type: "image",
      url: `https://cdn.example.com/asset-${i}.jpg`
    }));
    
    const startTime = Date.now();
    
    const result = await handleAddCreativeAssets({
      media_buy_id: "test_id",
      assets: assets
    });
    
    const duration = Date.now() - startTime;
    
    expect(duration).toBeLessThan(10000); // Should batch efficiently
    expect(result.validation_results).toHaveLength(100);
  });
});
```

## Update Operations: PATCH Semantics

**CRITICAL LESSON**: Updates use PATCH semantics - only modify included fields!

```typescript
async function handleUpdateMediaBuy(params: UpdateMediaBuyParams): Promise<UpdateResponse> {
  // PATCH semantics: Only update provided fields
  const updates = {};
  
  if (params.packages) {
    // Only update these specific packages
    for (const pkg of params.packages) {
      // Update ONLY the fields provided for this package
      await updatePackage(pkg.package_id, pkg);
    }
    // Other packages remain unchanged!
  }
  
  if (params.targeting) {
    // Campaign-level targeting update
    updates.targeting = params.targeting;
  }
  
  // Apply updates
  await applyMediaBuyUpdates(params.media_buy_id, updates);
  
  return {
    message: "Successfully updated media buy",
    context_id: params.context_id,
    media_buy_id: params.media_buy_id
  };
}
```

## Monitoring and Observability

### Key Metrics to Track

**LESSON LEARNED**: Comprehensive monitoring is essential for production reliability and debugging.

```typescript
class AdCPMetrics {
  private metrics: Map<string, any> = new Map();
  
  // Core business metrics
  trackTaskExecution(taskName: string, duration: number, success: boolean) {
    this.incrementCounter(`adcp.task.${taskName}.total`);
    this.incrementCounter(`adcp.task.${taskName}.${success ? 'success' : 'failure'}`);
    this.recordHistogram(`adcp.task.${taskName}.duration_ms`, duration);
  }
  
  trackMediaBuyCreation(mediaBuyId: string, totalBudget: number, packageCount: number) {
    this.incrementCounter('adcp.media_buy.created');
    this.recordHistogram('adcp.media_buy.budget', totalBudget);
    this.recordHistogram('adcp.media_buy.packages', packageCount);
    this.recordGauge('adcp.media_buy.active', this.getActiveCount());
  }
  
  trackApprovalFlow(mediaBuyId: string, status: 'requested' | 'approved' | 'rejected', timeInQueue?: number) {
    this.incrementCounter(`adcp.approval.${status}`);
    if (timeInQueue) {
      this.recordHistogram('adcp.approval.queue_time_ms', timeInQueue);
    }
  }
  
  // Performance metrics
  trackDatabaseQuery(operation: string, duration: number) {
    this.recordHistogram(`db.query.${operation}.duration_ms`, duration);
  }
  
  trackAPICall(endpoint: string, statusCode: number, duration: number) {
    this.incrementCounter(`api.${endpoint}.${statusCode}`);
    this.recordHistogram(`api.${endpoint}.duration_ms`, duration);
  }
  
  // Error tracking
  trackError(errorCode: string, context: any) {
    this.incrementCounter(`adcp.error.${errorCode}`);
    console.error(`Error ${errorCode}:`, context);
  }
}

// Structured logging for debugging
class AdCPLogger {
  private requestId: string;
  
  constructor(requestId: string) {
    this.requestId = requestId;
  }
  
  log(level: 'info' | 'warn' | 'error', message: string, data?: any) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      requestId: this.requestId,
      message,
      ...data
    };
    
    // Output as structured JSON for log aggregation
    console.log(JSON.stringify(logEntry));
  }
  
  // Task lifecycle logging
  logTaskStart(taskName: string, params: any) {
    this.log('info', `Task ${taskName} started`, {
      task: taskName,
      params: this.sanitizeParams(params)
    });
  }
  
  logTaskComplete(taskName: string, duration: number, resultSummary?: any) {
    this.log('info', `Task ${taskName} completed`, {
      task: taskName,
      duration_ms: duration,
      result: resultSummary
    });
  }
  
  logTaskError(taskName: string, error: any) {
    this.log('error', `Task ${taskName} failed`, {
      task: taskName,
      error: {
        code: error.code,
        message: error.message,
        stack: error.stack
      }
    });
  }
  
  // Remove sensitive data from logs
  private sanitizeParams(params: any): any {
    const sanitized = { ...params };
    // Remove sensitive fields
    delete sanitized.api_key;
    delete sanitized.auth_token;
    delete sanitized.password;
    return sanitized;
  }
}

// Usage in task handler
async function instrumentedTaskHandler(taskName: string, handler: Function) {
  return async (params: any) => {
    const requestId = params.request_id || generateRequestId();
    const logger = new AdCPLogger(requestId);
    const metrics = new AdCPMetrics();
    const startTime = Date.now();
    
    logger.logTaskStart(taskName, params);
    
    try {
      const result = await handler(params);
      const duration = Date.now() - startTime;
      
      logger.logTaskComplete(taskName, duration, {
        itemCount: result.products?.length || result.packages?.length
      });
      metrics.trackTaskExecution(taskName, duration, true);
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.logTaskError(taskName, error);
      metrics.trackTaskExecution(taskName, duration, false);
      metrics.trackError(error.code || 'unknown', { taskName });
      
      throw error;
    }
  };
}
```

### Health Checks and Readiness

```typescript
class HealthCheckService {
  async checkHealth(): Promise<HealthStatus> {
    const checks = await Promise.allSettled([
      this.checkDatabase(),
      this.checkExternalAPIs(),
      this.checkQueueSystem(),
      this.checkResourceUsage()
    ]);
    
    const failures = checks.filter(c => c.status === 'rejected');
    
    return {
      status: failures.length === 0 ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: {
        database: checks[0].status === 'fulfilled',
        external_apis: checks[1].status === 'fulfilled',
        queue_system: checks[2].status === 'fulfilled',
        resources: checks[3].status === 'fulfilled'
      },
      details: failures.map(f => f.reason?.message)
    };
  }
  
  private async checkDatabase(): Promise<void> {
    // Verify database connectivity
    const result = await db.query('SELECT 1');
    if (!result) throw new Error('Database check failed');
  }
  
  private async checkExternalAPIs(): Promise<void> {
    // Check critical external dependencies
    const apis = ['platform1', 'platform2'];
    for (const api of apis) {
      const response = await fetch(`${api}/health`);
      if (!response.ok) throw new Error(`API ${api} unhealthy`);
    }
  }
  
  private async checkResourceUsage(): Promise<void> {
    const usage = process.memoryUsage();
    const heapUsedPercent = (usage.heapUsed / usage.heapTotal) * 100;
    
    if (heapUsedPercent > 90) {
      throw new Error(`High memory usage: ${heapUsedPercent.toFixed(1)}%`);
    }
  }
}
```

## Troubleshooting Common Issues

### Issue: Tasks Timing Out

**Symptoms**: Tasks fail with timeout errors, especially for large operations.

**Root Causes**:
1. Synchronous operations blocking the event loop
2. Inefficient database queries
3. External API slowness

**Solutions**:
```typescript
// Problem: Blocking operation
const products = getAllProducts(); // Blocks if large dataset

// Solution: Stream or paginate
async function* streamProducts() {
  let offset = 0;
  const limit = 100;
  
  while (true) {
    const batch = await getProductsBatch(offset, limit);
    if (batch.length === 0) break;
    
    for (const product of batch) {
      yield product;
    }
    
    offset += limit;
  }
}

// Use streaming
for await (const product of streamProducts()) {
  await processProduct(product);
}
```

### Issue: Context Loss Between Requests

**Symptoms**: AI agents lose conversation context, requests seem disconnected.

**Root Causes**:
1. Not persisting context_id
2. Context expiration
3. Incorrect context retrieval

**Solutions**:
```typescript
class ContextManager {
  private contexts = new Map<string, Context>();
  private readonly TTL = 3600000; // 1 hour
  
  saveContext(contextId: string, data: any): void {
    this.contexts.set(contextId, {
      data,
      lastAccessed: Date.now(),
      created: Date.now()
    });
    
    // Persist to database for durability
    db.saveContext(contextId, data);
  }
  
  async getContext(contextId: string): Promise<Context | null> {
    // Try memory first
    let context = this.contexts.get(contextId);
    
    // Fall back to database
    if (!context) {
      context = await db.getContext(contextId);
      if (context) {
        this.contexts.set(contextId, context);
      }
    }
    
    // Check expiration
    if (context && Date.now() - context.lastAccessed > this.TTL) {
      this.contexts.delete(contextId);
      await db.deleteContext(contextId);
      return null;
    }
    
    // Update last accessed
    if (context) {
      context.lastAccessed = Date.now();
    }
    
    return context;
  }
}
```

### Issue: Inconsistent Product Discovery Results

**Symptoms**: Same query returns different results, missing expected products.

**Root Causes**:
1. Caching issues
2. Index not updated
3. Fuzzy matching too aggressive/conservative

**Solutions**:
```typescript
class ProductDiscovery {
  private cache = new LRUCache<string, Product[]>({
    max: 100,
    ttl: 300000 // 5 minutes
  });
  
  async discoverProducts(brief: string): Promise<Product[]> {
    const cacheKey = this.getCacheKey(brief);
    
    // Check cache with versioning
    const cached = this.cache.get(cacheKey);
    if (cached && !this.isStale(cached)) {
      return cached;
    }
    
    // Ensure index is current
    await this.refreshIndexIfNeeded();
    
    // Use consistent scoring
    const results = await this.searchWithScoring(brief);
    
    // Cache results
    this.cache.set(cacheKey, results);
    
    return results;
  }
  
  private async searchWithScoring(brief: string): Promise<Product[]> {
    // Consistent relevance scoring
    const scores = new Map<string, number>();
    
    // Multiple matching strategies
    const exactMatches = await this.exactMatch(brief);
    const fuzzyMatches = await this.fuzzyMatch(brief, 0.7); // 70% threshold
    const semanticMatches = await this.semanticMatch(brief);
    
    // Combine and deduplicate
    const allMatches = [...exactMatches, ...fuzzyMatches, ...semanticMatches];
    const unique = this.deduplicateProducts(allMatches);
    
    // Sort by relevance
    return unique.sort((a, b) => scores.get(b.id) - scores.get(a.id));
  }
}
```

### Issue: Memory Leaks in Long-Running Processes

**Symptoms**: Memory usage grows over time, eventual crashes.

**Root Causes**:
1. Event listeners not cleaned up
2. Large objects retained in closures
3. Unbounded caches

**Solutions**:
```typescript
class ResourceManager {
  private resources = new Set<() => void>();
  
  // Track resources for cleanup
  addCleanup(cleanup: () => void): void {
    this.resources.add(cleanup);
  }
  
  // Clean up all resources
  async cleanup(): Promise<void> {
    for (const cleanup of this.resources) {
      try {
        await cleanup();
      } catch (error) {
        console.error('Cleanup failed:', error);
      }
    }
    this.resources.clear();
  }
  
  // Example: Managed event listener
  addManagedListener(target: EventTarget, event: string, handler: Function): void {
    target.addEventListener(event, handler);
    this.addCleanup(() => target.removeEventListener(event, handler));
  }
  
  // Example: Bounded cache with eviction
  createBoundedCache<T>(maxSize: number): Map<string, T> {
    const cache = new Map<string, T>();
    
    return new Proxy(cache, {
      set(target, key, value) {
        // Evict oldest if at capacity
        if (target.size >= maxSize) {
          const firstKey = target.keys().next().value;
          target.delete(firstKey);
        }
        target.set(key, value);
        return true;
      }
    });
  }
}

// Usage
const manager = new ResourceManager();

// Auto-cleanup on process termination
process.on('SIGTERM', async () => {
  await manager.cleanup();
  process.exit(0);
});
```

## Data Validation Patterns

### Input Validation

**LESSON LEARNED**: Validate early and provide clear error messages for AI agents.

```typescript
class InputValidator {
  // Schema-based validation
  static validateMediaBuyParams(params: any): ValidationResult {
    const errors: ValidationError[] = [];
    
    // Required fields
    if (!params.name || params.name.trim().length === 0) {
      errors.push({
        field: 'name',
        message: 'Campaign name is required',
        code: 'required_field'
      });
    }
    
    // Package validation
    if (!params.packages || !Array.isArray(params.packages)) {
      errors.push({
        field: 'packages',
        message: 'At least one package is required',
        code: 'required_field'
      });
    } else {
      params.packages.forEach((pkg, index) => {
        // Budget validation
        if (!pkg.budget || pkg.budget <= 0) {
          errors.push({
            field: `packages[${index}].budget`,
            message: 'Budget must be positive',
            code: 'invalid_value'
          });
        }
        
        // Check minimum budget per platform
        const minBudget = this.getMinimumBudget(pkg.product_id);
        if (pkg.budget < minBudget) {
          errors.push({
            field: `packages[${index}].budget`,
            message: `Budget must be at least ${minBudget} for this product`,
            code: 'below_minimum',
            details: { minimum: minBudget, provided: pkg.budget }
          });
        }
        
        // Date validation
        if (pkg.flight_dates) {
          const start = new Date(pkg.flight_dates.start);
          const end = new Date(pkg.flight_dates.end);
          
          if (start >= end) {
            errors.push({
              field: `packages[${index}].flight_dates`,
              message: 'End date must be after start date',
              code: 'invalid_date_range'
            });
          }
          
          if (start < new Date()) {
            errors.push({
              field: `packages[${index}].flight_dates.start`,
              message: 'Start date cannot be in the past',
              code: 'past_date'
            });
          }
        }
      });
    }
    
    return {
      valid: errors.length === 0,
      errors: errors
    };
  }
  
  // Natural language brief validation
  static validateBrief(brief: string): ValidationResult {
    const errors: ValidationError[] = [];
    
    if (brief.length < 10) {
      errors.push({
        field: 'brief',
        message: 'Brief too short. Please provide more details about your target audience.',
        code: 'insufficient_detail'
      });
    }
    
    if (brief.length > 5000) {
      errors.push({
        field: 'brief',
        message: 'Brief too long. Please summarize to under 5000 characters.',
        code: 'exceeds_limit'
      });
    }
    
    // Check for required context
    const hasAudience = /\b(audience|people|users|customers|viewers)\b/i.test(brief);
    const hasGoal = /\b(reach|engage|convert|drive|increase|promote)\b/i.test(brief);
    
    if (!hasAudience && !hasGoal) {
      errors.push({
        field: 'brief',
        message: 'Brief should describe your target audience or campaign goals',
        code: 'missing_context'
      });
    }
    
    return {
      valid: errors.length === 0,
      errors: errors
    };
  }
}

// Usage in handler
async function handleCreateMediaBuy(params: any) {
  // Validate input
  const validation = InputValidator.validateMediaBuyParams(params);
  
  if (!validation.valid) {
    return {
      error: {
        code: 'invalid_request',
        message: 'Validation failed',
        details: {
          validation_errors: validation.errors
        }
      }
    };
  }
  
  // Proceed with valid input
  return await createMediaBuy(params);
}
```

## Protocol-Specific Considerations

### MCP Considerations
- **Polling Required**: Clients must poll for async operation completion
- **Custom HITL**: Implement your own approval workflow
- **Context via Parameters**: Pass context_id in every request
- **Error for Pending**: Use error responses for pending states

### A2A Considerations
- **Native Streaming**: Use SSE for real-time updates
- **Built-in HITL**: Leverage native approval states
- **Automatic Context**: Context persists across interactions
- **Artifacts for Data**: Return structured data as artifacts

## Common Implementation Mistakes

### ❌ Don't Do This:
```typescript
// Wrong: Exposing internal implementation details
return {
  id: "prod_123",
  targeting_template: { ... },  // Internal field!
  implementation_config: { ... }, // Internal field!
  database_id: 456  // Internal field!
}
```

### ✅ Do This Instead:
```typescript
// Correct: Only return protocol-defined fields
return {
  id: "prod_123",
  name: "Premium Video Package",
  dimensions: { ... },
  pricing: { ... }
}
```

### ❌ Don't Do This:
```typescript
// Wrong: Treating pending states as errors
if (response.status === "pending_manual") {
  throw new Error("Operation failed - pending approval"); // NO!
}

// Wrong: Synchronous blocking operations
function createMediaBuy(params) {
  const result = longRunningOperation(); // Blocks!
  return result;
}
```

### ✅ Do This Instead:
```typescript
// Correct: Pending states are normal workflow
if (response.status === "pending_manual") {
  // Track the operation and monitor for completion
  await trackPendingOperation(response.task_id);
  return { status: "awaiting_approval", task_id: response.task_id };
}

// Correct: Return immediately with pending status
async function createMediaBuy(params) {
  const mediaBuy = { 
    id: generateId(),
    status: "pending_activation" // Normal state, not an error!
  };
  
  // Process asynchronously
  processInBackground(mediaBuy.id, params);
  
  return {
    message: "Media buy created, awaiting creative upload",
    media_buy_id: mediaBuy.id,
    status: mediaBuy.status
  };
}
```

## Principal-Based Multi-Tenancy

**LESSON LEARNED**: Simple token auth with principal isolation works well.

```typescript
class PrincipalManager {
  async validatePrincipal(token: string): Promise<Principal> {
    // Simple token validation
    const principal = await this.db.principals.findOne({ token });
    if (!principal) {
      throw new AuthError("Invalid principal token");
    }
    return principal;
  }
  
  async scopeQueryToPrincipal(principal: Principal, query: any): Promise<any> {
    // All queries must be scoped to principal
    return {
      ...query,
      principal_id: principal.id
    };
  }
}

// Use in every request handler
async function handleRequest(req: Request) {
  const principal = await validatePrincipal(req.headers['x-adcp-auth']);
  const scopedParams = await scopeQueryToPrincipal(principal, req.params);
  // Process with scoped params...
}
```

## Validation Checklist

Before considering your implementation complete:

### Core Requirements (Both Protocols)
- [ ] All responses include `message` field as first field
- [ ] All tasks return correct response schemas
- [ ] Error responses follow AdCP error specification
- [ ] Async operations return immediately with pending status
- [ ] Pending states (`pending_manual`, `pending_activation`) handled as normal
- [ ] Human approval workflows are implemented where needed
- [ ] Updates use PATCH semantics (only modify included fields)
- [ ] Natural language briefs accepted in `get_products`
- [ ] All required fields are present in responses
- [ ] No internal implementation details leak in responses
- [ ] Date/time fields use ISO 8601 format
- [ ] Monetary values are in the specified currency
- [ ] IDs are unique and persistent
- [ ] State transitions follow the lifecycle diagram
- [ ] Principal-based multi-tenancy is enforced

### MCP-Specific
- [ ] Context persistence via context_id parameter
- [ ] Polling endpoints for async operations
- [ ] Task status endpoints implemented
- [ ] Webhook support for notifications (optional)

### A2A-Specific
- [ ] SSE endpoints for real-time updates
- [ ] Context management handled automatically
- [ ] Artifacts used for structured data returns
- [ ] HITL states properly implemented

## Getting Help

- Review the [API Reference](./api-reference.md) for detailed schemas
- Check [Design Decisions](./design-decisions.md) for architectural guidance
- See [Media Buy Lifecycle](./media-buy-lifecycle.md) for state management
- Consult [Error Codes](../reference/error-codes.md) for standard errors

## Next Steps

After implementing the Media Buy specification:
1. Add [Signals](../signals/agent-implementation-guide.md) support for real-time optimization
2. Implement [Discovery](../discovery/implementation-guide.md) for enhanced product matching
3. Add [Curation](../curation/coming-soon.md) when specification is available