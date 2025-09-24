---
title: Media Buy Lifecycle
description: Complete lifecycle management for advertising campaigns from creation to optimization using AdCP's unified media buy operations.
keywords: [media buy lifecycle, campaign management, advertising campaigns, media buy operations, campaign optimization]
sidebar_position: 4
---

# Media Buy Lifecycle

Media buys represent the complete lifecycle of advertising campaigns in AdCP. The AdCP:Buy protocol provides a unified interface for managing media buys across multiple advertising platforms, from initial campaign creation through ongoing optimization and updates.

## Overview

AdCP's media buy management provides a unified interface for:

- **Campaign Creation** from discovered products and packages
- **Lifecycle Management** through all campaign states  
- **Budget and Targeting Updates** for ongoing optimization
- **Cross-Platform Orchestration** with consistent operations
- **Asynchronous Operations** with human-in-the-loop support

## The Media Buy Lifecycle Phases

### 1. Creation Phase
Transform discovered products into active advertising campaigns using [`create_media_buy`](../task-reference/create_media_buy):

- **Package Configuration**: Combine products with formats, targeting, and budget
- **Campaign Setup**: Define timing, overall budget, and promoted offering
- **Validation & Approval**: Automated checks with optional human approval
- **Platform Deployment**: Campaign creation across advertising platforms

This phase may involve:
- Immediate creation with `pending_activation` status
- Human approval workflow with `pending_manual` status
- Permission requirements with `pending_permission` status

**Platform Mapping:**
- **Google Ad Manager**: Creates an Order with LineItems
- **Kevel**: Creates a Campaign with Flights
- **Triton Digital**: Creates a Campaign with Flights

### 2. Creative Upload Phase
Once created, the media buy requires creative assets via [`sync_creatives`](../task-reference/sync_creatives):

- **Platform-specific format support** (video, audio, display, custom)
- **Validation and policy review** for creative compliance
- **Assignment to specific packages** for targeted delivery

### 3. Activation & Delivery Phase
Monitor and manage active campaigns:

- **Status Tracking**: Campaign transitions from `pending_activation` to `active`
- **Creative Assignment**: Attach assets from the creative library
- **Delivery Monitoring**: Track pacing and performance metrics with [`get_media_buy_delivery`](../task-reference/get_media_buy_delivery)
- **Issue Resolution**: Handle approval delays and platform issues

### 4. Optimization & Reporting Phase
Ongoing performance monitoring and data-driven campaign optimization using AdCP's comprehensive reporting tools.

Key activities include:
- **Performance monitoring** with real-time and historical analytics
- **Campaign optimization** through budget reallocation and targeting refinement
- **Dimensional reporting** using the same targeting dimensions for consistent analysis
- **AI-driven insights** through performance feedback loops

For complete details on optimization strategies, performance monitoring, standard metrics, and best practices, see **[Optimization & Reporting](./optimization-reporting)**.

## Key Concepts

### Media Buy Structure
A media buy contains:
- **Campaign metadata** (buyer reference, promoted offering, timing)
- **Overall budget** with currency and pacing preferences
- **Multiple packages** representing different targeting/creative combinations
- **Status tracking** through creation, approval, and execution phases


### Package Model
Packages are the building blocks of media buys:
- **Product selection** from discovery results
- **Creative formats** to be provided for this package
- **Targeting overlays** for audience refinement beyond product defaults
- **Budget allocation** as portion of overall media buy budget

### Lifecycle States
Media buys progress through predictable states:
- **`pending_activation`**: Created, awaiting platform setup
- **`pending_manual`**: Requires human approval
- **`active`**: Running and delivering impressions
- **`paused`**: Temporarily stopped
- **`completed`**: Finished successfully


## Core Operations

### Creating Media Buys
The creation process handles:
- **Product validation** ensuring discovered products are still available
- **Format compatibility** checking creative requirements across packages
- **Budget distribution** allocating spend across multiple packages
- **Platform coordination** creating campaigns across multiple ad servers

### Updating Media Buys  
Modification capabilities include:
- **Budget adjustments** for increased/decreased spend
- **Targeting updates** to refine audience parameters
- **Package modifications** adding/removing products and formats
- **Schedule changes** for extended or shortened campaign timing

### Status Management
Campaign state transitions:
- **Activation requests** to start pending campaigns
- **Pause/resume operations** for campaign control
- **Completion handling** for successful campaign closure
- **Error recovery** for failed operations

## Response Times

Media buy operations use a unified status system with predictable timing:

- **[`create_media_buy`](../task-reference/create_media_buy)**: Instant to days
  - `completed`: Simple campaigns created immediately  
  - `working`: Processing within 120 seconds (validation, setup)
  - `submitted`: Complex campaigns requiring hours to days (human approval)
  
- **[`update_media_buy`](../task-reference/update_media_buy)**: Instant to days
  - `completed`: Budget changes applied immediately
  - `working`: Targeting updates within 120 seconds
  - `submitted`: Package modifications requiring approval (hours to days)

- **[`get_media_buy_delivery`](../task-reference/get_media_buy_delivery)**: ~60 seconds (data aggregation)
- **Performance analysis**: ~1 second (cached metrics)

**Status Meanings:**
- **`completed`**: Operation finished, process results immediately
- **`working`**: Processing, expect completion within 120 seconds  
- **`submitted`**: Long-running operation, provide webhook or poll with `tasks/get`

## Best Practices

### Campaign Planning
- **Start with clear objectives** defined in your product discovery brief
- **Plan package structure** around distinct audience/creative combinations
- **Set realistic budgets** based on product pricing guidance
- **Allow time for approval** in publisher workflows

### Ongoing Management
- **Monitor daily pacing** to ensure delivery against targets
- **Review performance weekly** for optimization opportunities
- **Update targeting gradually** to avoid disrupting delivery
- **Refresh creatives regularly** to prevent audience fatigue

### Budget Management
- **Allocate conservatively** initially, then increase based on performance
- **Reserve budget** for high-performing packages
- **Plan for seasonality** in audience availability and pricing
- **Monitor spend efficiency** across different targeting approaches
- **Budget Management**: The system automatically recalculates impressions based on CPM when budgets are updated

### Technical Implementation
- **Pause/Resume Strategy**: Use campaign-level controls for maintenance, package-level for optimization
- **Performance Monitoring**: Regular status checks and delivery reports ensure campaigns stay on track
- **Asynchronous Design**: Design orchestrators to handle long-running operations gracefully
- **Task Tracking**: Maintain persistent storage for pending task IDs
- **Webhook Integration**: Implement webhooks for real-time updates
- **User Communication**: Clearly communicate pending states to end users

## Error Handling

For comprehensive error handling guidance including pending vs error states, response patterns, and recovery strategies, see [Protocol Error Handling](../../protocols/error-handling.md).

Media buy specific error codes are documented in each task specification and the [Error Codes Reference](../../reference/error-codes.md).

## Asynchronous Operations and Human-in-the-Loop

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

## Standard Metrics

All platforms must support these core metrics:

- **impressions**: Number of ad views
- **spend**: Amount spent in currency
- **clicks**: Number of clicks (if applicable)
- **ctr**: Click-through rate (clicks/impressions)

Optional standard metrics:

- **conversions**: Post-click/view conversions
- **viewability**: Percentage of viewable impressions
- **completion_rate**: Video/audio completion percentage
- **engagement_rate**: Platform-specific engagement metric

## Platform-Specific Considerations

Different platforms offer varying reporting and optimization capabilities:

### Google Ad Manager
- Orders can contain multiple LineItems
- LineItems map 1:1 with packages
- Sophisticated targeting and frequency capping
- Requires creative approval process
- **Reporting**: Comprehensive dimensional reporting, real-time and historical data, advanced viewability metrics

### Kevel
- Campaigns contain Flights
- Flights map 1:1 with packages
- Real-time decisioning engine
- Supports custom creative templates
- **Reporting**: Real-time reporting API, custom metric support, flexible aggregation options

### Triton Digital
- Optimized for audio advertising
- Campaigns contain Flights for different dayparts
- Strong station/stream targeting capabilities
- Audio-only creative support
- **Reporting**: Audio-specific metrics (completion rates, skip rates), station-level performance data, daypart analysis

## Advanced Analytics

### Cross-Campaign Analysis
- **Portfolio performance** across multiple campaigns
- **Audience overlap** and frequency management
- **Budget allocation** optimization across campaigns

### Predictive Insights
- **Performance forecasting** based on historical data
- **Optimization recommendations** from AI analysis
- **Trend prediction** for proactive adjustments

## Integration Patterns

### Discovery to Media Buy
Seamless flow from product discovery to campaign creation:
1. Use [`get_products`](../task-reference/get_products) to find inventory
2. Select products that align with campaign objectives
3. Configure packages with appropriate targeting and formats
4. Create media buy with [`create_media_buy`](../task-reference/create_media_buy)

### Creative Integration
Coordinate with creative management:
1. Understand format requirements from selected products
2. Prepare assets using [Creative Management](../creatives/)
3. Assign creatives during campaign creation or via updates
4. Monitor creative performance and refresh as needed

### Performance Optimization
Data-driven campaign improvement leveraging comprehensive analytics:

1. **Track delivery** with [`get_media_buy_delivery`](../task-reference/get_media_buy_delivery)
   - Monitor real-time delivery metrics and pacing analysis
   - Get package-level performance breakdown for optimization opportunities
   - Track performance across different targeting approaches

2. **Analyze performance** across packages and targeting
   - Use dimensional reporting for granular insights
   - Monitor performance index scores for AI-driven optimization
   - Identify high and low performing segments

3. **Update campaigns** with [`update_media_buy`](../task-reference/update_media_buy)
   - Reallocate budgets between high and low performing packages
   - Adjust targeting based on performance data
   - Pause underperforming packages and scale successful ones

4. **Iterate** based on performance data and business outcomes
   - Feed performance data back into optimization algorithms
   - Continuously refine targeting and creative assignments
   - Scale successful strategies across similar campaigns

#### Optimization Best Practices
1. **Report Frequently**: Regular reporting improves optimization opportunities
2. **Track Pacing**: Monitor delivery against targets to avoid under/over-delivery
3. **Analyze Patterns**: Look for performance trends across dimensions
4. **Consider Latency**: Some metrics may have attribution delays
5. **Normalize Metrics**: Use consistent baselines for performance comparison

## Related Documentation

- **[Product Discovery](../product-discovery/)** - Finding inventory for media buys
- **[Task Reference](../task-reference/)** - Complete API documentation
- **[Creatives](../creatives/)** - Creative asset management
- **[Orchestrator Design Guide](../advanced-topics/orchestrator-design)** - Implementation best practices
