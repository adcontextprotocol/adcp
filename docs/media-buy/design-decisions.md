---
title: Design Decisions
---

# Design Decisions

This document captures key design decisions made in the AdCP:Buy protocol and implementation, highlighting areas where industry feedback would be valuable.

## 1. Package Model: Single Flight per Package

### Current Design
Each package in a media buy maps to exactly one flight/line item on the underlying platform.

```
Media Buy (Campaign/Order)
├── Package 1 → Flight/LineItem 1
├── Package 2 → Flight/LineItem 2
└── Package 3 → Flight/LineItem 3
```

### Rationale
- **Simplicity**: Easier mental model for buyers
- **1:1 Mapping**: Clear relationship between business and technical entities
- **Covers 90% of use cases**: Most campaigns don't need sub-flight complexity

### Alternative: Multi-Flight Packages
Some use cases might benefit from multiple flights per package:
- **A/B Testing**: Different creatives within same inventory
- **Time Segmentation**: Weekday vs weekend delivery patterns
- **Audience Splits**: Different targeting for same product

### 🔵 Industry Question
Should AdCP support multiple flights per package? What are the real-world use cases?

## 2. Update Semantics: PATCH vs PUT

### Current Design
All update operations use PATCH semantics - only included fields are modified.

```json
// This only updates these two packages
{
  "media_buy_id": "abc123",
  "packages": [
    {"package_id": "pkg1", "active": false},
    {"package_id": "pkg2", "budget": 50000}
  ]
}
// pkg3, pkg4, etc. remain unchanged
```

### Rationale
- **Safety**: Can't accidentally affect omitted items
- **Flexibility**: Update any subset without knowing full state
- **Industry Standard**: Follows REST best practices

### Alternative: Replace Semantics
PUT-style updates where the provided list replaces all packages.

### 🔵 Industry Question
Is PATCH semantics clear enough? Do buyers ever want "replace all" behavior?

## 3. Package Deletion: Soft Delete Only

### Current Design
No hard delete operation. Packages are paused (`active: false`) to remove from delivery.

### Rationale
- **Preserves History**: Reporting and analytics remain intact
- **Reversible**: Can reactivate if needed
- **Audit Trail**: Complete record of campaign changes

### Trade-offs
- **Clutter**: Paused packages accumulate over time
- **No True Removal**: Can't completely remove mistaken packages

### 🔵 Industry Question
Should we support hard delete with appropriate warnings? What about archiving?

## 4. Creative Assignment Model

### Current Design
Creatives are assigned to packages at upload time.

```json
{
  "creative_id": "banner_v1",
  "package_assignments": ["pkg1", "pkg2"]
}
```

### Rationale
- **Upfront Declaration**: Clear creative-to-package mapping
- **Platform Optimization**: Allows platforms to optimize delivery

### Alternative: Dynamic Assignment
Allow reassigning creatives to different packages after upload.

### 🔵 Industry Question
Do buyers need to move creatives between packages? How often?

## 5. Budget Management

### Current Design
Two ways to update package budgets:
1. **Budget Update**: Provide dollars, system calculates impressions
2. **Impression Update**: Directly set impression goals

### Rationale
- **Flexibility**: Support both financial and impression-based planning
- **CPM Awareness**: Budget updates respect negotiated CPM rates

### Edge Cases
- What if CPM changes mid-flight?
- How to handle over-delivery credits?

### 🔵 Industry Question
Should budget updates allow CPM renegotiation? How are make-goods handled?

## 6. Targeting Hierarchy

### Current Design
Two-level targeting model:
1. **Campaign Level**: Global targeting for all packages
2. **Package Level**: Additional refinements (additive)

### Rationale
- **Efficiency**: Set common targeting once
- **Flexibility**: Refine per package as needed
- **Additive Model**: Package targeting narrows, never expands

### Alternative: Override Model
Package targeting completely replaces campaign targeting.

### 🔵 Industry Question
Is additive targeting intuitive? Should packages be able to expand beyond campaign targeting?

## 7. Performance Feedback

### Current Design
Performance index (0.0-2.0) indicates relative performance:
- 1.0 = Baseline expected performance
- 1.5 = 50% better than expected
- 0.5 = 50% worse than expected

### Rationale
- **Normalized**: Works across different KPIs
- **Relative**: Accounts for market conditions
- **Simple**: Single number for optimization

### Limitations
- **Opaque**: Doesn't specify what's performing well/poorly
- **Aggregated**: Loses granular insights

### 🔵 Industry Question
Should performance feedback include specific metrics (CTR, viewability, etc.)?

## 8. Multi-Tenancy Model

### Current Design
Principal-based isolation with header authentication.

```
x-adcp-auth: <principal_token>
```

### Rationale
- **Simple**: One token per principal
- **Stateless**: No session management
- **Platform Mapping**: Each principal maps to platform-specific advertiser IDs

### Alternative: OAuth/JWT
Industry standard authentication with refresh tokens.

### 🔵 Industry Question
Is simple token auth sufficient? Need for OAuth2 integration?

## 9. Natural Language Discovery

### Current Design
First tool (`discover_products`) accepts natural language brief.

```json
{
  "campaign_brief": "reach millennials interested in fitness during morning hours"
}
```

### Rationale
- **AI-Native**: Designed for LLM agents
- **Accessible**: No need to know product codes
- **Flexible**: Handles vague or specific requests

### Trade-off
- **Ambiguity**: Less precise than structured search
- **AI Dependence**: Requires good NLP model

### 🔵 Industry Question
Should we also offer structured search for precision? Faceted filters?

## 10. Dry Run Mode

### Current Design
Environment variable (`AdCP_DRY_RUN=true`) shows platform API calls without execution.

### Rationale
- **Testing**: Safe experimentation
- **Learning**: Understand platform mappings
- **Debugging**: See exact API calls

### Enhancement Ideas
- Cost estimation in dry run
- Availability checking without commitment
- What-if scenarios

### 🔵 Industry Question
What additional information would be valuable in dry run mode?

## 11. Multi-Protocol Compatibility and Task Concept

### Current Design
AdCP uses a task-based architecture that maps to different protocol implementations:
- **MCP (Model Context Protocol)**: Tasks map to MCP tools for AI-to-application communication
- **A2A (Agent2Agent)**: Tasks support asynchronous operations with SSE and Human-in-the-Loop
- **Protocol Abstraction**: Task definitions remain consistent across protocols

### Task Architecture
Each task represents a discrete operation with:
- **Unified Interface**: Same parameters and responses across protocols
- **Protocol-Specific Features**: Enhanced capabilities per protocol (e.g., SSE in A2A)
- **Context Persistence**: `context_id` maintains state across interactions

```json
// Task request (protocol-agnostic)
{
  "context_id": null,  // First request
  "parameters": {...}
}

// Task response (includes context for persistence)
{
  "context_id": "ctx-abc-123",  // Server-created context
  "result": {...}
}
```

### Rationale
- **Flexibility**: Support multiple integration patterns
- **Consistency**: Unified experience across protocols
- **Evolution**: New protocols can be added without changing task definitions
- **AI-Native**: Optimized for LLM tool calling patterns

### Protocol Mapping
- **Synchronous Operations**: Direct MCP tool calls
- **Asynchronous Operations**: A2A with task_id polling/SSE
- **Human Approval**: A2A HITL workflows
- **Batch Operations**: Future protocol extensions

### 🔵 Industry Question
Are there other protocols we should support? How can we make task definitions more extensible?

## Future Considerations

### Potential Future Features
1. **Package Templates**: Reusable package configurations
2. **Campaign Cloning**: Duplicate successful campaigns
3. **Bulk Operations**: Update multiple media buys
4. **Forecasting**: Predictive delivery estimates
5. **Cross-Campaign Optimization**: Holistic budget allocation

### Platform Evolution
- **CTV/Streaming**: Advanced targeting for connected TV
- **Audio**: Podcast and streaming audio specifics
- **DOOH**: Digital out-of-home considerations
- **Retail Media**: In-store and e-commerce integration

## Conclusion

These design decisions shape the AdCP:Buy protocol's usability and capabilities. Industry feedback on these choices will help evolve the protocol to better serve the advertising ecosystem.

**To provide feedback**: https://github.com/adcp-protocol/specs/issues