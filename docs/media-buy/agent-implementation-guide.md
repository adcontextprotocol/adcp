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

Implement comprehensive error handling:

```typescript
// Use standard AdCP error codes
enum ErrorCode {
  INVALID_REQUEST = "invalid_request",
  PRODUCT_NOT_FOUND = "product_not_found",
  INSUFFICIENT_BUDGET = "insufficient_budget",
  CREATIVE_VALIDATION_FAILED = "creative_validation_failed",
  // ... see error-codes.md for full list
}

function handleError(error: any): AdcpError {
  // Map internal errors to AdCP standard errors
  if (error instanceof ValidationError) {
    return {
      code: ErrorCode.INVALID_REQUEST,
      message: error.message,
      details: error.validationErrors
    };
  }
  
  // Default error response
  return {
    code: ErrorCode.INTERNAL_ERROR,
    message: "An unexpected error occurred",
    request_id: generateRequestId()
  };
}
```

## Testing Your Implementation

### 1. Unit Test Each Task
```typescript
describe("get_products", () => {
  it("should return products matching brief", async () => {
    const result = await handleGetProducts({
      brief: "I need to reach millennials in California"
    });
    
    expect(result).toHaveLength(greaterThan(0));
    expect(result[0]).toHaveProperty("dimensions");
  });
});
```

### 2. Integration Test the Workflow
```typescript
describe("complete media buy workflow", () => {
  it("should create and activate a campaign", async () => {
    // 1. Discover products
    const products = await getProducts({ brief: "..." });
    
    // 2. Create media buy
    const mediaBuy = await createMediaBuy({
      packages: [{ product_id: products[0].id, budget: 1000 }]
    });
    
    // 3. Add creatives
    await addCreativeAssets({
      media_buy_id: mediaBuy.id,
      assets: [...]
    });
    
    // 4. Check delivery
    const delivery = await getMediaBuyDelivery({
      media_buy_id: mediaBuy.id
    });
    
    expect(delivery.status).toBe("active");
  });
});
```

### 3. Test Error Scenarios
- Invalid product IDs
- Insufficient budgets
- Malformed creatives
- Network failures
- Timeout handling

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