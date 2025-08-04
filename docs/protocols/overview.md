---
sidebar_position: 1
title: Protocol Support
---

# Protocol Support

AdCP is designed to work with multiple communication protocols, allowing implementers to choose the best fit for their use case. All AdCP tasks can be accessed through any supported protocol.

## Supported Protocols

### Model Context Protocol (MCP)

MCP is Anthropic's protocol for AI-to-application communication. It provides:
- Synchronous request/response model
- Tool-based interactions
- Simple integration with Claude and other AI assistants

**Best for:**
- Direct AI assistant integration
- Simple request/response workflows
- Existing MCP ecosystems

**Learn more:** [MCP Integration Guide](./mcp.md)

### Agent2Agent Protocol (A2A)

A2A is Google's protocol for agent-to-agent communication. It provides:
- Task-based asynchronous workflows
- Native human-in-the-loop support
- Real-time status updates via SSE
- Context management across interactions

**Best for:**
- Complex multi-step workflows
- Operations requiring approvals
- Cross-agent collaboration
- Long-running operations

**Learn more:** [A2A Integration Guide](./a2a.md)

### REST API (Coming Soon)

Traditional REST endpoints for direct HTTP integration.

**Best for:**
- Simple integrations
- Existing REST infrastructure
- Direct API access

## How It Works

AdCP uses a task-first architecture where:

1. **Core Tasks**: Business logic is implemented as tasks (e.g., `create_media_buy`, `get_signals`)
2. **Protocol Adapters**: Thin translation layers expose tasks through different protocols
3. **Consistent Behavior**: The same task works identically across all protocols

```
         ┌──────────┐ ┌──────────┐ ┌──────────┐
         │   MCP    │ │   A2A    │ │   REST   │
         │ Adapter  │ │ Adapter  │ │ Adapter  │
         └────┬─────┘ └────┬─────┘ └────┬─────┘
              └────────┬────┴────────────┘
                       ▼
              ┌─────────────────┐
              │  AdCP Tasks     │
              │                 │
              │ • get_signals   │
              │ • activate_signal│
              │ • create_media_buy│
              │ • add_creatives │
              └─────────────────┘
```

## Choosing a Protocol

| Feature | MCP | A2A | REST |
|---------|-----|-----|------|
| **Async Operations** | Polling | Native | Polling |
| **Status Updates** | Manual | Streaming | Manual |
| **Human-in-the-Loop** | Custom | Native | Custom |
| **Context Management** | Manual | Automatic | Manual |
| **Complexity** | Low | Medium | Low |

## Implementation Notes

- All protocols provide access to the same underlying tasks
- Protocol choice doesn't affect functionality, only the interaction model
- Implementers can support multiple protocols simultaneously
- New protocols can be added without changing core task implementations