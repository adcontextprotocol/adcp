# A2A Integration Flow Examples

## Example 1: Cross-Platform Campaign Coordination

This example shows how an A2A orchestrator could coordinate a campaign across multiple AdCP-enabled platforms.

```mermaid
sequenceDiagram
    participant User
    participant A2A_Orchestrator as A2A Orchestrator
    participant AdCP_GAM as AdCP Agent<br/>(Google Ad Manager)
    participant AdCP_TTD as AdCP Agent<br/>(The Trade Desk)
    participant AdCP_Signals as AdCP Signals<br/>(Scope3)

    User->>A2A_Orchestrator: "Create $100K campaign for sports fans"
    
    Note over A2A_Orchestrator: Parse intent and plan workflow
    
    par Parallel Discovery
        A2A_Orchestrator->>AdCP_Signals: A2A: "Find sports audience signals"
        AdCP_Signals-->>A2A_Orchestrator: Sports signals found
    and
        A2A_Orchestrator->>AdCP_GAM: A2A: "Get CTV inventory for sports"
        AdCP_GAM-->>A2A_Orchestrator: 5 products available
    and
        A2A_Orchestrator->>AdCP_TTD: A2A: "Get display inventory for sports"
        AdCP_TTD-->>A2A_Orchestrator: 3 products available
    end
    
    Note over A2A_Orchestrator: Optimize budget allocation
    
    par Execute Campaigns
        A2A_Orchestrator->>AdCP_GAM: A2A: "Create $60K CTV campaign"
        AdCP_GAM-->>A2A_Orchestrator: media_buy_id: gam_12345
    and
        A2A_Orchestrator->>AdCP_TTD: A2A: "Create $40K display campaign"
        AdCP_TTD-->>A2A_Orchestrator: media_buy_id: ttd_67890
    end
    
    A2A_Orchestrator->>User: Campaigns created across platforms
```

## Example 2: MCP to A2A Bridge Scenario

This shows how a traditional MCP orchestrator could leverage A2A agents through a bridge.

```mermaid
sequenceDiagram
    participant MCP_Client as MCP Orchestrator
    participant AdCP_Agent as AdCP Sales Agent<br/>(Dual Protocol)
    participant A2A_Analytics as A2A Analytics Agent<br/>(External)
    participant A2A_Creative as A2A Creative Agent<br/>(External)

    MCP_Client->>AdCP_Agent: MCP: create_media_buy(...)
    
    Note over AdCP_Agent: Need performance data
    
    AdCP_Agent->>A2A_Analytics: A2A: "Analyze performance for similar campaigns"
    A2A_Analytics-->>AdCP_Agent: Performance insights
    
    Note over AdCP_Agent: Need creative adaptations
    
    AdCP_Agent->>A2A_Creative: A2A: "Generate variations for CTV campaign"
    
    Note over A2A_Creative: Long-running task
    A2A_Creative-->>AdCP_Agent: task_id: task_123, status: working
    A2A_Creative-->>AdCP_Agent: SSE: Progress update (50%)
    A2A_Creative-->>AdCP_Agent: SSE: Task completed
    
    AdCP_Agent-->>MCP_Client: Media buy created with optimizations
```

## Example 3: Human-in-the-Loop Approval Flow

This demonstrates how A2A's async model supports AdCP's HITL operations.

```mermaid
sequenceDiagram
    participant A2A_Client as A2A Client
    participant AdCP_Agent as AdCP Sales Agent
    participant Human as Human Approver
    participant Webhook as Approval System

    A2A_Client->>AdCP_Agent: A2A: "Create $1M campaign (requires approval)"
    
    AdCP_Agent->>AdCP_Agent: Validate campaign parameters
    
    AdCP_Agent-->>A2A_Client: task_id: task_456, status: pending_approval
    
    AdCP_Agent->>Webhook: POST: Approval required notification
    
    Webhook->>Human: Email/Slack notification
    
    Human->>Webhook: Approve campaign
    
    Webhook->>AdCP_Agent: POST: Approval granted
    
    AdCP_Agent->>AdCP_Agent: Execute campaign creation
    
    AdCP_Agent-->>A2A_Client: SSE: Task completed, media_buy_id: mb_789
```

## Protocol Interaction Patterns

### Pattern 1: Protocol Selection

```javascript
// Client can choose protocol based on capabilities
if (agent.supports('a2a') && needsAsyncWorkflow) {
  // Use A2A for complex, long-running tasks
  await agent.a2a.send({
    message: "Analyze and optimize all active campaigns"
  });
} else if (agent.supports('mcp')) {
  // Use MCP for direct tool execution
  await agent.mcp.call('get_media_buy_delivery', {
    media_buy_id: 'mb_123'
  });
}
```

### Pattern 2: Protocol Translation

```javascript
// A2A request translated to MCP tools
async function handleA2ARequest(message) {
  const intent = parseIntent(message);
  
  switch(intent.action) {
    case 'create_campaign':
      // Map to MCP tools
      const products = await mcp.call('get_products', {
        brief: intent.brief
      });
      
      return await mcp.call('create_media_buy', {
        packages: products.map(p => p.product_id),
        total_budget: intent.budget
      });
  }
}
```

### Pattern 3: Cross-Protocol Context

```javascript
// Maintain context across protocols
class ContextManager {
  async handleMCPCall(tool, params, context) {
    // Store context from MCP interaction
    this.storeContext(context.sessionId, {
      protocol: 'mcp',
      tool,
      params,
      timestamp: Date.now()
    });
  }
  
  async handleA2ATask(task, context) {
    // Retrieve context from previous interactions
    const history = this.getContext(context.sessionId);
    
    // Use history to provide continuity
    return this.processWithContext(task, history);
  }
}
```

## Benefits of Integration

1. **Flexibility**: Clients can choose the most appropriate protocol
2. **Interoperability**: AdCP agents can work with the broader A2A ecosystem
3. **Scalability**: A2A's async model handles complex workflows
4. **Backward Compatibility**: Existing MCP clients continue to work
5. **Innovation**: Enables new multi-agent collaborative workflows