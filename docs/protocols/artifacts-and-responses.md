---
sidebar_position: 6
title: Artifacts and Responses
---

# Artifacts and Responses in AdCP

## Overview

AdCP supports both MCP and A2A protocols with consistent underlying data structures. Both protocols deliver the same information, formatted appropriately for their transport mechanisms.

## Core Data Structure

Regardless of protocol, all AdCP responses contain:
- **message**: Human-readable summary of the result
- **data**: Structured response data  
- **context_id**: Session continuity identifier

## Protocol Representations

### MCP Format
Direct JSON response with fields at root level:
```json
{
  "message": "Found 5 video products with CPMs from $15-45",
  "context_id": "ctx-123",
  "data": {
    "products": [
      {
        "product_id": "video_premium",
        "name": "Premium Video",
        "cpm": 35,
        "formats": ["video_16x9"]
      }
    ],
    "total": 5,
    "filters_applied": {
      "format_types": ["video"]
    }
  }
}
```

### A2A Format  
Task-based response with artifacts containing the same data:
```json
{
  "task": {
    "task_id": "task-789",
    "status": "completed"
  },
  "contextId": "ctx-123",
  "artifacts": [{
    "name": "product_catalog",
    "parts": [
      {
        "kind": "text",
        "text": "Found 5 video products with CPMs from $15-45"
      },
      {
        "kind": "data",
        "data": {
          "products": [
            {
              "product_id": "video_premium", 
              "name": "Premium Video",
              "cpm": 35,
              "formats": ["video_16x9"]
            }
          ],
          "total": 5,
          "filters_applied": {
            "format_types": ["video"]
          }
        }
      }
    ]
  }]
}
```

## Key Principles

1. **Data Consistency**: The `data` field in MCP maps directly to the `data` part in A2A artifacts
2. **Message Preservation**: The `message` field appears as a `text` part in A2A
3. **Context Continuity**: Both protocols maintain context_id for session state
4. **Schema Compatibility**: JSON schemas are identical across protocols

## Task-Specific Guidance

### Synchronous Operations

#### get_products
- **Purpose**: Product discovery and browsing
- **Response Type**: Immediate results
- **Artifact Structure**: Single artifact with text summary + structured data
- **Multiple Parts**: Text explanation + product data
- **Multiple Artifacts**: Only when grouping by distinct categories

```json
{
  "artifacts": [{
    "name": "product_catalog", 
    "parts": [
      { "kind": "text", "text": "Found 12 premium CTV products perfect for your sports campaign" },
      { "kind": "data", "data": { "products": [...], "total": 12 } }
    ]
  }]
}
```

#### list_creative_formats
- **Purpose**: Format specification discovery
- **Response Type**: Immediate results  
- **Artifact Structure**: Single artifact (formats are cohesive)
- **Multiple Parts**: Text summary + format specifications

### Asynchronous Operations

#### create_media_buy
- **Purpose**: Complex workflow with validation and approvals
- **Response Type**: Task ID with status updates, final confirmation
- **Artifact Structure**: Confirmation with multiple parts (JSON + contract)
- **Progress Updates**: Via messages during execution

```json
// During execution (message)
{
  "message": "Creating line items in ad server...",
  "progress": { "current": 3, "total": 5 }
}

// Final result (artifact)
{
  "artifacts": [{
    "name": "media_buy_confirmation",
    "parts": [
      {
        "kind": "data",
        "data": {
          "media_buy_id": "mb_123",
          "status": "active",
          "total_budget": 50000
        }
      },
      {
        "kind": "file",
        "uri": "https://contracts.example.com/mb_123.pdf"
      }
    ]
  }]
}
```

#### add_creative_assets
- **Purpose**: File processing, validation, and assignment
- **Response Type**: Task with progress updates, multiple results
- **Artifact Structure**: One artifact per creative processed
- **Multiple Artifacts**: Each creative gets its own artifact

```json
{
  "artifacts": [
    {
      "name": "hero_video_30s",
      "artifactId": "art-creative-001",
      "parts": [
        { "kind": "data", "data": { "creative_id": "...", "status": "approved" } }
      ]
    },
    {
      "name": "hero_video_15s", 
      "artifactId": "art-creative-002",
      "parts": [
        { "kind": "data", "data": { "creative_id": "...", "status": "pending_review" } }
      ]
    }
  ]
}
```

### Adaptive Operations

#### get_media_buy_delivery
- **Purpose**: Performance reporting and analytics
- **Response Type**: Sync for small queries, async for large reports
- **Artifact Structure**: Multiple parts for different data formats
- **Large Reports**: CSV + JSON + summary text

```json
{
  "artifacts": [{
    "name": "delivery_report",
    "parts": [
      { "kind": "text", "text": "Campaign delivered 2.3M impressions (95% of goal)" },
      { "kind": "data", "data": { "summary": {...}, "daily_breakdown": [...] } },
      { "kind": "file", "uri": "detailed_report.csv" }
    ]
  }]
}
```

## Multiple Parts vs Multiple Artifacts

### Use Multiple Parts When:
- **Different representations** of the same result (JSON + PDF contract)
- **Progressive enhancement** (summary + detailed data)  
- **Mixed media** for single concept (data + visualization)
- **Related content** that should be consumed together

### Use Multiple Artifacts When:
- **Independent results** that can be processed separately
- **Different semantic outputs** (analysis + recommendations)
- **Batch processing** results (one per item processed)
- **Distinct deliverables** with different purposes

## Implementation Guidelines

### For Both Protocols
1. **Identical Data Schema**: Use the same JSON structure in MCP `data` and A2A `data` parts
2. **Consistent Messages**: Generate the same human-readable summaries
3. **Same Validation**: Apply identical business rules and validation
4. **Error Compatibility**: Use the same error codes and structures

### For A2A Implementations
1. **Artifact Naming**: Use descriptive, consistent names (`product_catalog`, `media_buy_confirmation`)
2. **Part Ordering**: Place text parts before data parts for readability
3. **Metadata Usage**: Include relevant metadata in artifact objects
4. **Size Considerations**: Large data should use file parts with URIs

### For MCP Implementations  
1. **Response Structure**: Always include message, context_id, and data fields
2. **Async Tasks**: Return task_id and status for long-running operations
3. **Progress Reports**: Use consistent progress object structure
4. **Error Handling**: Include both message and structured error details

## Conversational vs Direct Responses

A key design decision for A2A implementations is whether to respond conversationally (asking for clarification) or directly (providing results). AdCP handles this through a unified pattern:

### The Clarification Pattern

Both protocols use the same decision logic:
- **Direct Response**: When the request has sufficient information
- **Conversational Response**: When clarification would improve the result
- **Decision Signal**: The `clarification_needed` field indicates response type

### MCP Clarification Example
```json
{
  "message": "I'd be happy to help find products. Could you share your budget and target audience?",
  "data": {
    "products": [],
    "clarification_needed": true,
    "suggested_information": ["budget", "target audience", "campaign timing"]
  }
}
```

### A2A Clarification Example  
```json
{
  "task": {
    "task_id": "task-products-def", 
    "status": "completed"
  },
  "contextId": "ctx-products-456",
  "message": {
    "parts": [{
      "kind": "text",
      "text": "I'd be happy to help find products for your campaign. Could you share your budget and target audience?"
    }]
  },
  "artifacts": []
}
```

**Key Difference**: A2A clarification requests use the `message` field (like MCP) rather than artifacts, since they're communication, not deliverables.

### Implementation Guidelines

1. **MCP Clarifications**: Use the `message` field with structured data indicating `clarification_needed: true`
2. **A2A Clarifications**: Use the `message` field for questions, empty `artifacts` array
3. **A2A Direct Responses**: Use `artifacts` with populated data when delivering results
4. **Progressive Disclosure**: Ask for 2-4 pieces of information per turn, not everything
5. **Provide Context**: Explain why the information is needed in the message text
6. **Maintain Consistency**: Same conversational tone and logic across protocols

This pattern properly separates communication (messages) from deliverables (artifacts) while maintaining the same underlying decision logic across protocols.

## Best Practices

1. **Keep Messages Actionable**: Include next steps and key metrics
2. **Structure Data Consistently**: Use the same field names across all protocols
3. **Optimize for Consumers**: Consider how AI agents and humans will use the data
4. **Handle Large Responses**: Use pagination or file references for large datasets
5. **Maintain Context**: Ensure context_id flows correctly through multi-turn interactions
6. **Support Both Patterns**: Design for both conversational and direct interaction styles

This unified approach ensures that AdCP implementations can support both protocols seamlessly, with clients able to choose their preferred interaction pattern without losing functionality or consistency.