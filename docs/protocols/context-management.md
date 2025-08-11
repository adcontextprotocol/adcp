---
sidebar_position: 4
title: Context Management
---

# Context Management Across Protocols

AdCP uses a unified context management approach that works consistently across all protocols, maintaining state across operations and enabling multi-step workflows.

## The Context Model

### Core Structure

```typescript
interface AdCPContext {
  // Identity
  context_id: string;
  principal_id: string;
  created_at: string;
  updated_at: string;
  
  // Lifecycle
  state: 'active' | 'idle' | 'archived' | 'expired';
  ttl_seconds?: number;
  expires_at?: string;
  
  // Working memory
  working_state: {
    current_media_buy?: string;
    current_products?: string[];
    current_creatives?: string[];
    last_search?: any;
    preferences?: any;
    workflow?: any;
  };
  
  // Message history with retention
  messages: Message[];
  message_retention: {
    strategy: 'count' | 'time' | 'size';
    limit: number;
    summarize_on_truncate?: boolean;
  };
  
  // Task tracking
  active_tasks: string[];
  completed_tasks: string[];
}
```

### Context Lifecycle

Contexts move through defined states:

1. **Active**: Currently in use, refreshed on each interaction
2. **Idle**: No recent activity (5+ minutes)
3. **Archived**: Persisted for history
4. **Expired**: TTL reached, eligible for cleanup

Default TTL:
- **Interactive sessions**: 1 hour of inactivity
- **Async operations**: No timeout - persists until operation completes
- **HITL operations**: No timeout - may take days/weeks for approval

## How It Works

### First Request (No Context)
```json
// MCP
{
  "tool": "get_products",
  "arguments": {
    "context_id": null,  // or omitted
    "brief": "Looking for video inventory"
  }
}

// A2A
{
  "method": "message/send",
  "params": {
    "contextId": null,  // or omitted
    "message": {
      "parts": [{
        "kind": "text",
        "text": "Show me video products"
      }]
    }
  }
}
```

### First Response (Context Created)
```json
// MCP
{
  "context_id": "ctx-discovery-abc123",  // Server creates this
  "products": [...],
  "message": "Found 3 video products"
}

// A2A
{
  "contextId": "ctx-discovery-abc123",  // Same context!
  "message": {
    "parts": [{
      "kind": "text",
      "text": "Found 3 video products"
    }]
  }
}
```

### Subsequent Requests (With Context)
```json
// MCP
{
  "tool": "create_media_buy",
  "arguments": {
    "context_id": "ctx-discovery-abc123",  // Include context
    "packages": ["pkg_123"],  // Can reference discovered products
    "total_budget": 50000
  }
}

// A2A  
{
  "contextId": "ctx-discovery-abc123",  // Same context
  "message": {
    "parts": [{
      "kind": "text",
      "text": "Create campaign with the first product"
    }]
  }
}
```

## Working State Management

Context maintains working state across operations:

```javascript
// After product discovery
context.working_state = {
  last_search: {
    query: "video inventory",
    results: ["prod_1", "prod_2", "prod_3"],
    timestamp: "2025-01-15T10:00:00Z"
  },
  current_products: ["prod_1", "prod_2", "prod_3"]
}

// After media buy creation
context.working_state = {
  ...previous_state,
  current_media_buy: "mb_123",
  workflow: {
    step: "awaiting_creatives",
    data: { media_buy_id: "mb_123", deadline: "2025-01-20" }
  }
}

// Preferences learned during session
context.working_state = {
  ...previous_state,
  preferences: {
    budget_range: { min: 10000, max: 50000 },
    preferred_formats: ["video", "display"],
    targeting_preferences: { geo: ["US", "CA"] }
  }
}
```

## Message History and Retention

### Retention Policies

```javascript
// Count-based (default)
{
  strategy: 'count',
  limit: 50,  // Keep last 50 messages
  summarize_on_truncate: true  // Summarize old messages before removal
}

// Time-based
{
  strategy: 'time',
  limit: 3600,  // Keep messages for 1 hour
  summarize_on_truncate: false
}

// Size-based
{
  strategy: 'size',
  limit: 65536,  // 64KB limit
  summarize_on_truncate: true
}
```

### Message Summarization

When reaching retention limits with `summarize_on_truncate: true`:

```javascript
// Before truncation (51 messages, limit 50)
messages = [
  { role: "user", content: "Find video products" },
  { role: "assistant", content: "Found 3 products..." },
  ... // 49 more messages
]

// After truncation with summarization
messages = [
  { 
    role: "system", 
    content: "Summary: User searched for video products, found 3 options, discussed pricing..."
  },
  ... // Recent 49 messages
]
```

## Context Sharing Patterns

### Pattern 1: Task Inheritance

Tasks inherit context state but maintain isolation:

```javascript
async function createTaskWithContext(context_id, operation, params) {
  const context = await getContext(context_id);
  
  // Create task with inherited state
  const task = {
    task_id: generateId(),
    context_id,
    operation,
    params: {
      ...params,
      // Inherit preferences
      targeting: params.targeting || context.working_state.preferences?.targeting_preferences,
      budget: params.budget || context.working_state.preferences?.budget_range
    },
    inherited_state: {
      current_media_buy: context.working_state.current_media_buy,
      current_products: context.working_state.current_products
    }
  };
  
  // Track task in context
  context.active_tasks.push(task.task_id);
  await updateContext(context);
  
  return task;
}
```

### Pattern 2: Workflow Continuity

Multi-step workflows maintain state:

```javascript
// Step 1: Product discovery
const context = await createContext(principal_id);
await updateWorkingState(context.context_id, {
  workflow: {
    step: 'product_discovery',
    data: { products: ['prod_1', 'prod_2'] }
  }
});

// Step 2: Media buy creation (uses discovered products)
const workflow = context.working_state.workflow;
if (workflow?.step === 'product_discovery') {
  const selected_products = workflow.data.products;
  // Create media buy with these products
  await updateWorkingState(context.context_id, {
    workflow: {
      step: 'media_buy_creation',
      data: {
        products: selected_products,
        media_buy_id: 'mb_123'
      }
    }
  });
}

// Step 3: Creative upload (knows about media buy)
const current_mb = context.working_state.workflow?.data.media_buy_id;
// Upload creatives to this media buy
```

## Protocol-Specific Implementation

### MCP
- Uses `context_id` parameter in all requests/responses
- Context persists across tool calls
- State stored server-side

```javascript
// MCP Adapter
function adaptMCPRequest(tool, args) {
  return {
    context_id: args.context_id || null,
    ...args
  };
}

function adaptMCPResponse(result, context_id) {
  return {
    context_id: context_id,
    ...result
  };
}
```

### A2A
- Uses native `contextId` field
- Built-in conversation support
- Maps directly to unified context

```javascript
// A2A Adapter  
function adaptA2ARequest(message) {
  return {
    context_id: message.contextId || null,
    ...parseMessage(message)
  };
}

function adaptA2AResponse(result, context_id) {
  return {
    contextId: context_id,
    ...result
  };
}
```

### HTTP REST
- Context in headers or query params
- Session cookies as alternative
- Same semantics as other protocols

```javascript
// Option 1: Header
GET /api/products
X-Context-ID: ctx-123

// Option 2: Query parameter
GET /api/products?context_id=ctx-123

// Option 3: Session cookie
GET /api/products
Cookie: adcp_context=ctx-123
```

## Implementation Guidelines

### For Task Implementations

```javascript
class MediaBuyTask {
  async execute(input, ctx) {
    // 1. Get or create context
    const contextId = input.context_id || ctx.createContextId();
    
    // 2. Load existing state if available
    const state = await ctx.getState(contextId);
    
    // 3. Use state to enhance operation
    const enhancedParams = {
      ...input,
      // Use remembered preferences
      targeting: input.targeting || state?.preferences?.targeting,
      // Reference previous discoveries
      products: input.products || state?.current_products
    };
    
    // 4. Update state with results
    await ctx.setState(contextId, {
      ...state,
      current_media_buy: mediaBuyId,
      last_action: 'create_media_buy',
      last_action_time: new Date().toISOString()
    });
    
    // 5. Return context for future use
    return {
      context_id: contextId,  // MCP field
      contextId: contextId,   // A2A field (both for compatibility)
      media_buy_id: mediaBuyId,
      message: "Media buy created successfully"
    };
  }
}
```

### Context Cleanup

```javascript
class ContextCleaner {
  async cleanup() {
    const contexts = await getAllContexts();
    
    for (const context of contexts) {
      // Check expiration
      if (new Date(context.expires_at) < new Date()) {
        context.state = 'expired';
        
        // Archive if important
        if (this.shouldArchive(context)) {
          await this.archive(context);
        }
        
        // Delete expired context
        await this.deleteContext(context.context_id);
      }
      
      // Mark idle contexts
      else if (this.isIdle(context)) {
        context.state = 'idle';
        await this.updateContext(context);
      }
    }
  }
  
  private isIdle(context) {
    const idle_threshold = 300000; // 5 minutes
    const last_update = new Date(context.updated_at).getTime();
    return Date.now() - last_update > idle_threshold;
  }
}
```

## Best Practices

1. **Context Naming**: Use descriptive prefixes
   - `ctx-discovery-` for product searches
   - `ctx-campaign-` for media buy workflows
   - `ctx-creative-` for creative iterations

2. **Context Scope**: Keep focused on related operations
   - Don't mix unrelated workflows
   - Create new context for new intent

3. **State Size**: Limit working state to essential data
   - Maximum 64KB recommended
   - Archive large data separately

4. **Error Handling**: Graceful degradation
   ```javascript
   try {
     const context = await getContext(context_id);
     // Use context
   } catch (e) {
     if (e.code === 'CONTEXT_EXPIRED') {
       // Create new context
       context_id = createContext();
     }
   }
   ```

5. **Testing**: Always test both paths
   - With context (continued conversation)
   - Without context (fresh start)

## Migration Notes

### For Existing MCP Implementations
1. Add `context_id` to all tool parameters
2. Generate and return context_id in responses
3. Use context for state management
4. No breaking changes - context_id is optional

### For A2A Implementations
1. Already have contextId support
2. Ensure consistent context generation
3. Map contextId ↔ context_id for cross-protocol compatibility

### For New Implementations
1. Start with context support from day one
2. Use provided context management utilities
3. Follow retention and cleanup guidelines
4. Test context expiration scenarios