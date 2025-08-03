# AdCP Architecture: Task-First with Protocol Adapters

This directory contains the architectural evolution and final recommendation for AdCP's core architecture.

## Final Recommendation: Task-First Architecture ⭐

### [Task-First Architecture](./task-first-architecture.md) ⭐ **RECOMMENDED APPROACH**
The recommended architecture that uses Tasks as the core abstraction with protocol adapters:
- Tasks as the fundamental building block
- Protocol adapters (MCP, A2A, REST, etc.) as thin translation layers
- Clean separation between business logic and protocol concerns
- Future-proof design supporting any protocol

**Key Benefits:**
- Implementers only need to understand Tasks, not protocols
- Automatic support for all protocols (current and future)
- Consistent behavior across all interfaces
- Simplified testing and development

## Evolution of Thinking

The documents below show how we arrived at the task-first architecture:

### 1. [A2A Integration Proposal](./a2a-integration-proposal.md)
Initial proposal exploring how AdCP could support both MCP and A2A protocols. Includes:
- Background on both protocols
- Dual-protocol agent architecture
- Use cases and benefits
- Implementation approach

### 2. [A2A Integration Flow Examples](./a2a-integration-flow.md)
Visual flow diagrams showing:
- Cross-platform campaign coordination
- MCP to A2A bridge scenarios
- Human-in-the-loop approval flows
- Protocol interaction patterns

### 3. [A2A-First Architecture](./a2a-first-architecture.md)
Architecture based on the insight that A2A's Task model is fundamentally better for AdCP:
- Why Tasks are perfect for advertising workflows
- Native HITL support comparison
- Context management for multi-step workflows
- Real-world workflow examples

### 4. [A2A vs MCP Comparison](./a2a-mcp-comparison.md)
Detailed technical comparison showing why A2A is superior for AdCP use cases:
- Feature comparison table
- Code examples for common workflows
- Strengths and weaknesses of each protocol

### 5. [A2A Recommendation](./a2a-recommendation.md)
Executive summary recommending A2A as the primary protocol for AdCP with:
- Key reasons for choosing A2A
- Proposed architecture
- Implementation path
- Risk mitigation

## Example Code

See the example directories for implementation details:

**[`examples/task-first/`](../../examples/task-first/)** - Task-first implementation
- Simple task implementation showing how developers only need to focus on business logic

**[`examples/a2a-integration/`](../../examples/a2a-integration/)** - Protocol comparisons
- Dual-protocol agent implementation
- HITL comparison (MCP vs A2A)
- Creative workflow with A2A context

## Key Evolution of Insights

1. **Initial Insight**: A2A's Task model is superior to MCP's request/response for advertising workflows
2. **Deeper Insight**: Tasks are the right abstraction regardless of protocol
3. **Final Architecture**: Task-first design with protocol adapters provides:
   - Clean separation of concerns
   - Protocol independence for implementers
   - Future-proof architecture
   - Consistent behavior across all interfaces

## Why Task-First?

Advertising workflows are inherently **task-based**:
- Multi-step processes (inventory search → budget allocation → campaign creation)
- Human approvals (compliance, creative review, budget approval)
- Long-running operations (optimization, reporting)
- Context preservation (creative iterations, campaign adjustments)

By making Tasks the core abstraction, we:
- Let implementers focus on business logic only
- Handle protocol translation in adapters
- Support any current or future protocol
- Provide consistent features across all interfaces

## Next Steps

1. Define core Task interface specification
2. Build reference Task implementations
3. Create protocol adapters (MCP, A2A, REST)
4. Update AdCP specification to be task-first
5. Provide migration guide for existing implementations