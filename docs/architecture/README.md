# AdCP + A2A Integration Architecture

This directory contains the architectural proposal and analysis for integrating Google's Agent2Agent (A2A) protocol with AdCP.

## Documents

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

### 3. [A2A-First Architecture](./a2a-first-architecture.md) ⭐ **Key Document**
Revised architecture based on the insight that A2A's Task model is fundamentally better for AdCP:
- Why Tasks are perfect for advertising workflows
- Native HITL support comparison
- Context management for multi-step workflows
- Real-world workflow examples

### 4. [A2A vs MCP Comparison](./a2a-mcp-comparison.md)
Detailed technical comparison showing why A2A is superior for AdCP use cases:
- Feature comparison table
- Code examples for common workflows
- Strengths and weaknesses of each protocol

### 5. [Recommendation](./a2a-recommendation.md)
Executive summary recommending A2A as the primary protocol for AdCP with:
- Key reasons for choosing A2A
- Proposed architecture
- Implementation path
- Risk mitigation

## Example Code

See the [`examples/a2a-integration/`](../../examples/a2a-integration/) directory for:
- Dual-protocol agent implementation
- HITL comparison (MCP vs A2A)
- Creative workflow with A2A context

## Key Insight

Advertising workflows are inherently **task-based** with:
- Multi-step processes
- Human approvals
- Long-running operations
- Context preservation needs

A2A's Task abstraction provides these capabilities natively, while MCP would require building custom infrastructure. Therefore, we recommend building AdCP on A2A with MCP as a compatibility layer.

## Next Steps

1. Review with AdCP working group
2. Engage with A2A community
3. Build proof-of-concept
4. Update specifications