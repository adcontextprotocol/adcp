---
title: Media Buy Lifecycle
---

# Media Buy Lifecycle

## Overview

The AdCP:Buy protocol provides a unified interface for managing media buys across multiple advertising platforms. This document details the conceptual media buy lifecycle and management workflow.

## Media Buy Lifecycle Phases

### 1. Creation Phase

The media buy begins with the [`create_media_buy`](./tasks/create_media_buy) task, which creates a new campaign/order with one or more packages (flights/line items). This phase may involve:

- Immediate creation with `pending_activation` status
- Human approval workflow with `pending_manual` status
- Permission requirements with `pending_permission` status

**Platform Mapping:**
- **Google Ad Manager**: Creates an Order with LineItems
- **Kevel**: Creates a Campaign with Flights
- **Triton Digital**: Creates a Campaign with Flights

### 2. Creative Upload Phase

Once created, the media buy requires creative assets via [`add_creative_assets`](./tasks/add_creative_assets). Key aspects:

- Platform-specific format support (video, audio, display, custom)
- Validation and policy review
- Assignment to specific packages

### 3. Activation & Delivery Phase

After creatives are uploaded and approved:

- Campaign transitions from `pending_activation` to `active`
- Use [`check_media_buy_status`](./tasks/check_media_buy_status) to monitor status
- Track delivery progress and pacing

### 4. Optimization Phase

During delivery, optimize performance through:

- [`update_media_buy`](./tasks/update_media_buy) for budget and targeting adjustments
- Performance index updates for AI-driven optimization
- Package-level pause/resume for granular control

### 5. Reporting Phase

Monitor performance with [`get_media_buy_delivery`](./tasks/get_media_buy_delivery):

- Real-time delivery metrics
- Package-level performance breakdown
- Pacing analysis and optimization opportunities

## Asynchronous Operations and HITL

The AdCP:Buy protocol is designed for asynchronous operations as a core principle. Orchestrators MUST handle pending states gracefully.

### Human-in-the-Loop (HITL) Operations

Many publishers require manual approval for automated operations. The protocol supports this through the HITL task queue:

1. **Operation Request**: Orchestrator calls any modification task
2. **Pending Response**: Server returns `pending_manual` status with task ID
3. **Task Monitoring**: Orchestrator polls or receives webhooks
4. **Human Review**: Publisher reviews and approves/rejects
5. **Completion**: Original operation executes upon approval

### HITL Task States

```
pending → assigned → in_progress → completed/failed
                  ↓
              escalated
```

### Orchestrator Requirements

Orchestrators MUST:
1. Handle `pending_manual` and `pending_permission` as normal states
2. Store task IDs for tracking pending operations
3. Implement retry logic with exponential backoff
4. Handle eventual rejection of operations gracefully
5. Support webhook callbacks for real-time updates (recommended)

## Platform-Specific Considerations

### Google Ad Manager
- Orders can contain multiple LineItems
- LineItems map 1:1 with packages
- Sophisticated targeting and frequency capping
- Requires creative approval process

### Kevel
- Campaigns contain Flights
- Flights map 1:1 with packages
- Real-time decisioning engine
- Supports custom creative templates

### Triton Digital
- Optimized for audio advertising
- Campaigns contain Flights for different dayparts
- Strong station/stream targeting capabilities
- Audio-only creative support

## Best Practices

1. **Budget Management**: The system automatically recalculates impressions based on CPM when budgets are updated

2. **Pause/Resume Strategy**: Use campaign-level controls for maintenance, package-level for optimization

3. **Performance Monitoring**: Regular status checks and delivery reports ensure campaigns stay on track

4. **Asynchronous Design**: Design orchestrators to handle long-running operations gracefully

5. **Task Tracking**: Maintain persistent storage for pending task IDs

6. **Webhook Integration**: Implement webhooks for real-time updates

7. **User Communication**: Clearly communicate pending states to end users

## Error Handling Philosophy

### Pending States vs Errors

**Pending States (Normal Flow):**
- `pending_manual`: Operation requires human approval
- `pending_permission`: Operation blocked by permissions
- `pending_approval`: Awaiting ad server approval

These are NOT errors and should be handled as part of normal operation flow.

**Error States (Exceptional):**
- `failed`: Operation cannot be completed
- Authentication failures
- Invalid parameters
- Resource not found

## Related Documentation

- [Orchestrator Design Guide](./orchestrator-design) - Implementation best practices
- [Design Decisions](./design-decisions) - Architectural choices and rationale
- Task References: See individual task documentation for API details