---
sidebar_position: 7
title: Task Response Patterns
---

# Task Response Patterns

## Overview

Each AdCP task has specific response requirements based on its operation type and purpose. This guide provides detailed patterns for when to use artifacts vs messages and how to structure responses for optimal client consumption.

## Task Categories

### Discovery Tasks (Synchronous)

These tasks return immediately with complete results and are used for browsing and exploration.

#### get_products

**Operation Type**: Synchronous
**Typical Response Time**: < 1 second
**Context**: Product discovery and campaign planning

**Conversational vs Direct Response Pattern**:

AdCP supports both conversational (clarification) and direct (product list) responses based on the request context and brief quality:

- **Direct Response**: When brief is sufficient or filters are specific
- **Conversational Response**: When clarification would improve recommendations
- **Decision Factor**: `clarification_needed` field determines response type

**When to use artifacts vs messages**:
- **Direct Response**: Use artifacts for complete product catalog
- **Conversational Response**: Use artifacts for clarification questions + empty/partial results
- **Include in message**: Summary count, key insights, or clarification request
- **Multiple artifacts when**: Grouping products by distinct categories (rare)

**MCP Response Pattern**:
```json
{
  "message": "Found 12 CTV products with CPMs from $25-65. Premium Video offers the best reach for sports campaigns.",
  "context_id": "ctx-products-123",
  "data": {
    "products": [
      {
        "product_id": "ctv_premium_sports",
        "name": "Premium CTV - Sports",
        "cpm": 45,
        "min_spend": 25000,
        "formats": ["video_16x9"],
        "targeting_capabilities": ["geo", "demographic", "behavioral"]
      }
    ],
    "total": 12,
    "filters_applied": {
      "format_types": ["video"],
      "budget_range": "25000-100000"
    },
    "recommendations": [
      "Consider Premium Video for maximum reach",
      "Sports targeting available on 8 of these products"
    ]
  }
}
```

**A2A Response Pattern**:
```json
{
  "task": {
    "task_id": "task-products-abc",
    "status": "completed",
    "completed_at": "2025-01-27T10:30:00Z"
  },
  "contextId": "ctx-products-123",
  "artifacts": [{
    "name": "product_catalog",
    "parts": [
      {
        "kind": "text",
        "text": "Found 12 CTV products with CPMs from $25-65. Premium Video offers the best reach for sports campaigns."
      },
      {
        "kind": "data",
        "data": {
          "products": [
            {
              "product_id": "ctv_premium_sports",
              "name": "Premium CTV - Sports", 
              "cpm": 45,
              "min_spend": 25000,
              "formats": ["video_16x9"],
              "targeting_capabilities": ["geo", "demographic", "behavioral"]
            }
          ],
          "total": 12,
          "filters_applied": {
            "format_types": ["video"],
            "budget_range": "25000-100000"
          },
          "recommendations": [
            "Consider Premium Video for maximum reach",
            "Sports targeting available on 8 of these products"
          ]
        }
      }
    ]
  }]
}
```

**Conversational Response Pattern** (when clarification needed):

**MCP Clarification Response**:
```json
{
  "message": "I'd be happy to help find the right products for your campaign. To provide the best recommendations, could you share your campaign budget, target audience, and timing?",
  "context_id": "ctx-products-456",
  "data": {
    "products": [],
    "clarification_needed": true,
    "suggested_information": [
      "Campaign budget range",
      "Target geographic markets", 
      "Campaign start/end dates",
      "Success metrics or objectives"
    ]
  }
}
```

**A2A Clarification Response**:
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
      "text": "I'd be happy to help find the right products for your campaign. To provide the best recommendations, could you share your campaign budget, target audience, and timing?"
    }]
  },
  "artifacts": []
}
```

**Key Design Decision**: 
- **A2A Clarifications**: Use `message` field (communication), empty `artifacts` array
- **A2A Direct Responses**: Use `artifacts` field (deliverables) with populated data
- **MCP**: Uses `message` field + structured `data` for both patterns

This properly separates communication from deliverables in A2A while maintaining consistent logic across protocols.

#### list_creative_formats

**Operation Type**: Synchronous
**Context**: Understanding creative requirements before asset creation

**When to use artifacts vs messages**:
- **Use artifacts for**: Complete format specifications and requirements
- **Include in message**: Format count, most common dimensions
- **Single artifact**: Always (formats are a cohesive specification set)

**Response Pattern**:
```json
// MCP
{
  "message": "This publisher supports 8 creative formats. Video formats require 30s or 15s duration.",
  "data": {
    "formats": [
      {
        "format_id": "video_16x9_30s",
        "name": "Landscape Video 30s",
        "dimensions": { "width": 1920, "height": 1080 },
        "duration_seconds": 30,
        "file_types": ["mp4", "mov"],
        "max_file_size_mb": 100
      }
    ]
  }
}

// A2A Artifact
{
  "artifacts": [{
    "name": "creative_format_specs",
    "parts": [
      { "kind": "text", "text": "This publisher supports 8 creative formats. Video formats require 30s or 15s duration." },
      { "kind": "data", "data": { "formats": [...] } }
    ]
  }]
}
```

### Transaction Tasks (Asynchronous)

These tasks involve complex workflows, external validations, or human approvals.

#### create_media_buy

**Operation Type**: Asynchronous
**Typical Duration**: 2-10 minutes
**Context**: Campaign creation with validation, approval, and setup

**When to use artifacts vs messages**:
- **Use artifacts for**: Final confirmation details, contracts, campaign IDs
- **Use messages for**: Progress updates during creation process
- **Multiple parts**: JSON confirmation + PDF contract when available

**Progress Message Pattern** (during execution):
```json
{
  "task_id": "task-mb-456",
  "status": "processing",
  "message": "Validating inventory availability for CTV packages...",
  "progress": {
    "current": 2,
    "total": 5,
    "unit_type": "steps",
    "responsible_party": "system",
    "action_detail": "Checking inventory against requested impressions"
  }
}
```

**Final Artifact Pattern**:
```json
// MCP
{
  "message": "Successfully created media buy MB-12345 with $50,000 budget. Upload creatives by Feb 15 to activate campaign.",
  "context_id": "ctx-mb-creation",
  "data": {
    "media_buy_id": "mb-12345",
    "status": "pending_creatives",
    "total_budget": 50000,
    "creative_deadline": "2025-02-15T23:59:59Z",
    "packages": [
      {
        "package_id": "pkg-001",
        "product_name": "Premium CTV",
        "budget": 30000,
        "estimated_impressions": 1500000
      }
    ],
    "next_steps": [
      "Upload video creatives using add_creative_assets",
      "Review targeting settings if needed",
      "Monitor delivery after activation"
    ]
  }
}

// A2A
{
  "artifacts": [{
    "name": "media_buy_confirmation", 
    "parts": [
      {
        "kind": "data",
        "data": {
          "media_buy_id": "mb-12345",
          "status": "pending_creatives",
          "total_budget": 50000,
          "creative_deadline": "2025-02-15T23:59:59Z",
          "packages": [...],
          "next_steps": [...]
        }
      },
      {
        "kind": "file",
        "uri": "https://contracts.example.com/mb_12345.pdf",
        "name": "insertion_order.pdf"
      }
    ]
  }]
}
```

#### add_creative_assets

**Operation Type**: Asynchronous
**Typical Duration**: 30 seconds - 5 minutes
**Context**: File upload, processing, validation, and assignment

**When to use artifacts vs messages**:
- **Use artifacts for**: Each processed creative result
- **Use messages for**: Upload progress, validation status
- **Multiple artifacts**: One per creative asset (enables parallel processing)

**Progress Messages**:
```json
{
  "message": "Processing hero_video.mp4: validating format and duration...",
  "progress": { "current": 1, "total": 3, "unit_type": "assets" }
}
```

**Multiple Artifacts Pattern**:
```json
{
  "artifacts": [
    {
      "name": "hero_video_30s",
      "artifactId": "art-creative-001", 
      "parts": [
        {
          "kind": "data",
          "data": {
            "creative_id": "creative-30s-001",
            "original_filename": "hero_video.mp4",
            "status": "approved",
            "format_compliance": {
              "duration_check": "passed",
              "resolution_check": "passed", 
              "file_size_check": "passed"
            },
            "assigned_packages": ["pkg-001", "pkg-002"]
          }
        }
      ]
    },
    {
      "name": "hero_video_15s",
      "artifactId": "art-creative-002",
      "parts": [
        {
          "kind": "data", 
          "data": {
            "creative_id": "creative-15s-002",
            "original_filename": "hero_video_15s.mp4",
            "status": "pending_review",
            "format_compliance": {
              "duration_check": "passed",
              "resolution_check": "passed",
              "file_size_check": "warning_large"
            },
            "review_notes": "File size exceeds recommended limit but within acceptable range"
          }
        }
      ]
    }
  ]
}
```

### Update Tasks (Adaptive)

These tasks can be synchronous for simple changes or asynchronous for complex modifications.

#### update_media_buy

**Operation Type**: Adaptive (based on change complexity)
**Context**: Campaign modifications during or before flight

**When to use artifacts vs messages**:
- **Simple updates** (budget, dates): Return in message only
- **Complex updates** (targeting, packages): Use artifacts for change summary  
- **Include diff**: Show before/after states in structured format

**Simple Update Pattern** (Synchronous):
```json
{
  "message": "Updated daily budget for MB-12345 from $1,000 to $1,500. Change is effective immediately.",
  "data": {
    "media_buy_id": "mb-12345",
    "changes_applied": {
      "daily_budget": { "from": 1000, "to": 1500 }
    },
    "effective_date": "2025-01-27T10:30:00Z"
  }
}
```

**Complex Update Pattern** (Asynchronous with Artifacts):
```json
{
  "artifacts": [{
    "name": "media_buy_change_summary",
    "parts": [
      { "kind": "text", "text": "Successfully updated targeting and budget for 3 packages in MB-12345" },
      {
        "kind": "data",
        "data": {
          "media_buy_id": "mb-12345",
          "changes_summary": {
            "packages_modified": 3,
            "budget_change": { "from": 50000, "to": 75000 },
            "targeting_changes": {
              "added_regions": ["TX", "FL"],
              "removed_segments": ["3p:luxury_shoppers"]
            }
          },
          "change_diff": [
            {
              "package_id": "pkg-001",
              "field": "geo_region_any_of",
              "before": ["CA", "NY"],
              "after": ["CA", "NY", "TX", "FL"]
            }
          ]
        }
      }
    ]
  }]
}
```

### Reporting Tasks (Adaptive)

These tasks scale from quick summaries to comprehensive reports based on query scope.

#### get_media_buy_delivery

**Operation Type**: Adaptive
**Context**: Performance monitoring and optimization

**When to use artifacts vs messages**:
- **Small result sets**: Include summary in message, details in data
- **Large reports**: Use artifacts with multiple format options
- **Time series data**: Multiple parts for different granularities (daily + hourly)

**Small Query Pattern** (Synchronous):
```json
{
  "message": "MB-12345 has delivered 2.3M impressions (95% of goal) with $0.65 average CPM. Performance is on track.",
  "data": {
    "media_buy_id": "mb-12345",
    "delivery_summary": {
      "impressions_delivered": 2300000,
      "impressions_goal": 2400000,
      "delivery_percentage": 95.8,
      "spend": 1495.00,
      "average_cpm": 0.65
    }
  }
}
```

**Large Report Pattern** (Asynchronous with Artifacts):
```json
{
  "artifacts": [{
    "name": "comprehensive_delivery_report",
    "parts": [
      {
        "kind": "text", 
        "text": "Generated delivery report for 5 media buys over 90-day period. Total impressions: 45.2M across all campaigns."
      },
      {
        "kind": "data",
        "data": {
          "report_period": { "start": "2024-11-01", "end": "2025-01-30" },
          "summary": {
            "total_impressions": 45200000,
            "total_spend": 892000,
            "average_cpm": 19.75
          },
          "daily_breakdown": [...],
          "media_buy_performance": [...]
        }
      },
      {
        "kind": "file",
        "uri": "https://reports.example.com/delivery_detailed.csv",
        "name": "detailed_delivery_data.csv"
      }
    ]
  }]
}
```

## Decision Framework

### Synchronous vs Asynchronous
- **Sync if**: Result available in < 5 seconds, no external dependencies
- **Async if**: Processing time > 5 seconds, human approval needed, external API calls

### Single vs Multiple Artifacts
- **Single artifact**: Related data that should be consumed together
- **Multiple artifacts**: Independent results, batch processing outcomes

### Message Content Guidelines
- **Include**: Key metrics, next steps, important warnings
- **Avoid**: Technical details better suited for structured data
- **Format**: Natural language that both humans and AI can understand

### Data Structure Consistency
- **Same schema**: MCP `data` field = A2A `data` part
- **Same validation**: Apply identical business rules
- **Same errors**: Use consistent error codes and structures

This pattern guide ensures consistent, predictable responses across all AdCP implementations while leveraging the strengths of each protocol.