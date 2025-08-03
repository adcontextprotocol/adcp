# AdCP + A2A Integration: Architectural Proposal

## Executive Summary

This document proposes an architecture for integrating Google's Agent2Agent (A2A) protocol with the Advertising Context Protocol (AdCP). The integration would enable AdCP agents to communicate with other A2A-compatible agents, expanding the ecosystem and enabling new collaborative workflows.

## Background

### Current State

**AdCP** (Advertising Context Protocol):
- Built on Anthropic's Model Context Protocol (MCP)
- Focused on advertising workflows (media buying, signals, curation)
- Uses `.well-known/adcp.json` for agent discovery
- Agents expose MCP endpoints with specific tools

**A2A** (Agent2Agent Protocol):
- Open protocol by Google with Linux Foundation governance
- Uses JSON-RPC 2.0 over HTTP
- Agent Cards at `.well-known/agent.json`
- Supports async tasks with Server-Sent Events (SSE)
- Vendor-neutral, modality-agnostic

### Complementary Nature

As noted by Google's Rao Surapaneni: "We see MCP and A2A as complementary capabilities. The way we are looking at Agent2Agent is at a higher layer of abstraction to enable applications and agents to talk to each other."

## Proposed Architecture

### 1. Dual-Protocol Agent Architecture

AdCP agents would support both MCP (for tool interactions) and A2A (for agent-to-agent communication):

```
┌─────────────────────────────────────────┐
│           AdCP Agent                     │
├─────────────────────────────────────────┤
│  ┌───────────────┐  ┌────────────────┐ │
│  │  MCP Server   │  │  A2A Server    │ │
│  │  (Tools)      │  │  (Tasks)       │ │
│  └───────────────┘  └────────────────┘ │
│           │                │            │
│           ▼                ▼            │
│  ┌────────────────────────────────────┐│
│  │     Core Business Logic            ││
│  │  (Media Buy, Signals, Curation)    ││
│  └────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

### 2. Discovery Integration

Extend the AdCP discovery document to include A2A endpoints:

```json
{
  "sales": {
    "mcp": "https://salesagent.example.com/mcp",
    "a2a": "https://salesagent.example.com/a2a"
  },
  "signals": {
    "mcp": "https://signals.example.com/mcp",
    "a2a": "https://signals.example.com/a2a"
  }
}
```

Additionally, provide an A2A Agent Card at `.well-known/agent.json`:

```json
{
  "name": "AdCP Sales Agent",
  "description": "AI-powered media buying agent supporting AdCP and A2A protocols",
  "url": "https://salesagent.example.com/a2a",
  "authentication": ["bearer", "oauth2"],
  "supportedInputFormats": ["text/plain", "application/json"],
  "supportedOutputFormats": ["text/plain", "application/json", "application/pdf"],
  "skills": [
    {
      "name": "media_buy_planning",
      "description": "Plan and optimize media buying campaigns",
      "examples": [
        "Create a $50K CTV campaign targeting sports enthusiasts",
        "Optimize my current campaigns for better performance"
      ]
    },
    {
      "name": "inventory_discovery",
      "description": "Discover available advertising inventory",
      "examples": [
        "Find premium video inventory in California",
        "What audio inventory is available for drive time?"
      ]
    }
  ]
}
```

### 3. Protocol Bridging

Create a bridge layer that translates between MCP tool calls and A2A tasks:

```javascript
// Example: MCP tool call → A2A task
class AdCPBridge {
  async handleMCPToolCall(tool, params) {
    // MCP tool call from orchestrator
    if (tool === 'create_media_buy') {
      // Execute locally
      return this.createMediaBuy(params);
    }
  }

  async handleA2ATask(message) {
    // A2A task from external agent
    const intent = this.parseIntent(message);
    
    if (intent.type === 'media_buy_request') {
      // Convert to internal format
      const result = await this.createMediaBuy(intent.params);
      
      // Return A2A response
      return {
        artifacts: [{
          name: "media_buy_result",
          parts: [{
            kind: "application/json",
            data: result
          }]
        }]
      };
    }
  }
}
```

### 4. Use Cases Enabled

#### Cross-Platform Campaign Coordination

An A2A orchestrator could coordinate campaigns across multiple AdCP-enabled platforms:

```
A2A Orchestrator
    │
    ├──A2A──> AdCP Sales Agent (Google Ad Manager)
    ├──A2A──> AdCP Sales Agent (The Trade Desk)
    └──A2A──> AdCP Signals Agent (Scope3)
```

#### Intent-Based Workflows

Natural language intents could be processed by specialized agents:

```
User: "I need to reach sports fans with a $100K budget"
    │
    ▼
A2A Intent Processor
    │
    ├──A2A──> AdCP Signals Agent: "Find sports audience signals"
    ├──A2A──> AdCP Sales Agent: "Get CTV inventory for sports"
    └──A2A──> AdCP Curation Agent: "Create sports package"
```

#### Human-in-the-Loop Approval

A2A's async task model aligns well with AdCP's HITL operations:

```json
{
  "method": "message/send",
  "params": {
    "message": {
      "parts": [{
        "kind": "text",
        "text": "Create $50K campaign pending human approval"
      }]
    },
    "configuration": {
      "pushNotificationConfig": {
        "url": "https://approvals.example.com/webhook"
      }
    }
  }
}
```

## Implementation Approach

### Phase 1: A2A Wrapper for Existing Agents

Create an A2A server wrapper that exposes existing MCP tools as A2A tasks:

```javascript
class A2AWrapper {
  constructor(mcpAgent) {
    this.mcpAgent = mcpAgent;
    this.setupA2AServer();
  }

  async handleTask(message) {
    // Parse natural language or structured request
    const intent = await this.parseIntent(message);
    
    // Map to MCP tool
    const tool = this.mapIntentToTool(intent);
    
    // Execute via MCP
    const result = await this.mcpAgent.execute(tool, intent.params);
    
    // Return A2A response
    return this.formatA2AResponse(result);
  }
}
```

### Phase 2: Native A2A Integration

Build A2A support directly into AdCP agents:

1. **Shared Context Management**: Maintain conversation context across protocols
2. **Task Orchestration**: Support complex multi-step workflows
3. **Cross-Agent Collaboration**: Enable agents to delegate subtasks

### Phase 3: Advanced Features

1. **Multi-Modal Support**: Handle PDFs, images, and other artifacts
2. **Streaming Updates**: Use SSE for real-time campaign monitoring
3. **Agent Marketplace**: Discovery service for A2A-enabled AdCP agents

## Technical Considerations

### Authentication

A2A supports standard authentication methods that align with AdCP:
- Bearer tokens (current AdCP approach)
- OAuth2 (for enterprise integrations)

### Error Handling

Map AdCP error codes to A2A JSON-RPC errors:

```javascript
// AdCP error
{
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "Start date must be in the future"
  }
}

// A2A JSON-RPC error
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32602,
    "message": "Invalid params",
    "data": {
      "field": "start_date",
      "reason": "Start date must be in the future"
    }
  }
}
```

### Performance

- A2A's async model suits AdCP's long-running operations
- SSE enables efficient status updates without polling
- Task IDs allow tracking across system boundaries

## Migration Path

1. **Compatibility Mode**: Existing MCP clients continue working unchanged
2. **Dual Support**: New agents support both protocols
3. **Gradual Adoption**: Orchestrators can mix MCP and A2A agents
4. **Feature Parity**: Ensure all MCP tools have A2A equivalents

## Benefits

### For Publishers

- **Broader Reach**: Connect with A2A ecosystem (100+ partners)
- **Flexibility**: Support multiple orchestrator types
- **Innovation**: Enable new collaborative workflows

### For Orchestrators

- **Unified Interface**: Single protocol for diverse agents
- **Scalability**: A2A's async model handles complex workflows
- **Ecosystem**: Access to growing A2A agent marketplace

### For the Industry

- **Interoperability**: AdCP agents work with any A2A system
- **Standards Alignment**: Two major protocols working together
- **Future-Proof**: Prepared for multi-agent AI future

## Recommendations

1. **Start with Wrappers**: Build A2A wrappers for existing agents to test integration
2. **Extend Discovery**: Update `.well-known/adcp.json` to include A2A endpoints
3. **Pilot Programs**: Work with key partners to validate use cases
4. **Community Feedback**: Engage both AdCP and A2A communities
5. **Reference Implementation**: Create open-source bridge implementation

## Conclusion

Integrating A2A support into AdCP would:
- Expand the addressable ecosystem
- Enable new multi-agent workflows
- Position AdCP at the forefront of agent interoperability
- Maintain backward compatibility with existing MCP implementations

The complementary nature of MCP (for tools) and A2A (for agent communication) creates a powerful combination for the future of AI-powered advertising.

## Next Steps

1. Review proposal with AdCP working group
2. Engage with A2A community for feedback
3. Build proof-of-concept integration
4. Define formal specification for dual-protocol agents
5. Update AdCP documentation with A2A guidelines