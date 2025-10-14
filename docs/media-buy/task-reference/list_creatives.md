---
title: list_creatives
---

# list_creatives

Query and search the centralized creative library with advanced filtering, sorting, pagination, and optional data enrichment. This task enables efficient discovery and management of creative assets with flexible query capabilities.

**Response Time**: ~1 second (simple database lookup)

## Overview

The `list_creatives` task provides comprehensive search and filtering capabilities for the creative library. It supports complex queries with multiple filter types, sorting options, pagination for large result sets, and optional inclusion of enriched data like assignments and performance metrics.

**Key Features:**
- **Advanced Filtering**: Search by format, status, tags, dates, assignments, and more
- **Flexible Sorting**: Sort by creation date, update date, name, status, or performance metrics
- **Pagination Support**: Handle large creative libraries efficiently
- **Optional Data Enrichment**: Include assignments, performance data, and sub-assets as needed
- **Field Selection**: Return only specific fields to optimize response size
- **Tag-Based Discovery**: Support both "all tags" and "any tags" matching
- **Assignment Status Filtering**: Find assigned, unassigned, or package-specific creatives

## Request Parameters

### Core Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `adcp_version` | string | No | AdCP schema version (default: "1.5.0") |
| `filters` | object | No | Filter criteria for querying creatives |
| `sort` | object | No | Sorting parameters |
| `pagination` | object | No | Pagination controls |

### Data Inclusion Options

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `include_assignments` | boolean | No | Include package assignment information (default: true) |
| `include_performance` | boolean | No | Include performance metrics (default: false) |
| `include_sub_assets` | boolean | No | Include sub-assets for carousel/native formats (default: false) |
| `fields` | array | No | Specific fields to return (omit for all fields) |

## Filtering Options

### Format and Status Filtering

```json
{
  "filters": {
    "format": "video",                    // Single format
    "formats": ["video", "audio"],        // Multiple formats
    "status": "approved",                 // Single status
    "statuses": ["approved", "pending_review"] // Multiple statuses
  }
}
```

### Tag-Based Filtering

```json
{
  "filters": {
    "tags": ["q1_2024", "video"],        // ALL tags must match (AND)
    "tags_any": ["mobile", "desktop"]    // ANY tag must match (OR)
  }
}
```

### Text Search

```json
{
  "filters": {
    "name_contains": "nike",              // Case-insensitive name search
    "creative_ids": ["hero_video", "banner_300x250"] // Specific IDs
  }
}
```

### Date Range Filtering

```json
{
  "filters": {
    "created_after": "2024-01-01T00:00:00Z",
    "created_before": "2024-12-31T23:59:59Z",
    "updated_after": "2024-06-01T00:00:00Z",
    "updated_before": "2024-06-30T23:59:59Z"
  }
}
```

### Assignment Status Filtering

```json
{
  "filters": {
    "assigned_to_package": "pkg_ctv_001",           // Assigned to specific package
    "assigned_to_packages": ["pkg_001", "pkg_002"], // Assigned to any of these packages
    "unassigned": true                              // Unassigned creatives only
  }
}
```

### Third-Party and Performance Filtering

```json
{
  "filters": {
    "snippet_type": "vast_url",           // Filter by snippet type
    "has_performance_data": true          // Only creatives with performance data
  }
}
```

## Sorting Options

Sort results by various fields with ascending or descending order:

```json
{
  "sort": {
    "field": "created_date",              // created_date, updated_date, name, status, assignment_count, performance_score
    "direction": "desc"                   // asc or desc
  }
}
```

**Available Sort Fields:**
- `created_date` - When creative was uploaded (default)
- `updated_date` - When creative was last modified  
- `name` - Creative name (alphabetical)
- `status` - Approval status
- `assignment_count` - Number of package assignments
- `performance_score` - Aggregated performance metric

## Pagination

Control result set size and navigation:

```json
{
  "pagination": {
    "limit": 50,                          // Max results per page (1-100, default: 50)
    "offset": 0                           // Results to skip (default: 0)
  }
}
```

## Response Format

The response provides comprehensive creative data with optional enrichment:

```json
{
  "adcp_version": "1.5.0",
  "message": "Found 25 creatives matching your query",
  "context_id": "ctx_list_789012",
  "query_summary": {
    "total_matching": 25,
    "returned": 10,
    "filters_applied": ["format=video", "status=approved"]
  },
  "pagination": {
    "limit": 10,
    "offset": 0,
    "has_more": true,
    "total_pages": 3,
    "current_page": 1
  },
  "creatives": [
    {
      "creative_id": "hero_video_30s",
      "name": "Brand Hero Video 30s",
      "format_id": {
        "agent_url": "https://creative.adcontextprotocol.org",
        "id": "video_30s_vast"
      },
      "status": "approved",
      "created_date": "2024-01-15T10:30:00Z",
      "updated_date": "2024-01-15T14:20:00Z",
      // ... other creative fields
      "assignments": { /* if include_assignments=true */ },
      "performance": { /* if include_performance=true */ },
      "sub_assets": [ /* if include_sub_assets=true */ ]
    }
  ],
  "format_summary": {
    "video_30s_vast": 15,
    "display_300x250": 8,
    "audio_30s": 2
  },
  "status_summary": {
    "approved": 20,
    "pending_review": 3,
    "rejected": 2
  }
}
```

## Usage Examples

### Example 1: Basic Creative Library Query

List all approved video creatives:

```json
{
  "filters": {
    "format": "video",
    "status": "approved"
  },
  "sort": {
    "field": "created_date",
    "direction": "desc"
  },
  "pagination": {
    "limit": 20
  }
}
```

### Example 2: Search for Brand Campaign Creatives

Find all creatives for a Nike campaign with performance data:

```json
{
  "filters": {
    "name_contains": "nike",
    "has_performance_data": true,
    "created_after": "2024-01-01T00:00:00Z"
  },
  "include_performance": true,
  "sort": {
    "field": "performance_score",
    "direction": "desc"
  }
}
```

### Example 3: Find Unassigned Creatives

Get creatives ready for assignment to new campaigns:

```json
{
  "filters": {
    "unassigned": true,
    "status": "approved"
  },
  "sort": {
    "field": "created_date",
    "direction": "desc"
  },
  "pagination": {
    "limit": 50
  }
}
```

### Example 4: Package-Specific Creative Query

Find all creatives assigned to a specific package:

```json
{
  "filters": {
    "assigned_to_package": "pkg_ctv_premium_001"
  },
  "include_assignments": true,
  "include_performance": true,
  "sort": {
    "field": "assignment_count",
    "direction": "desc"
  }
}
```

### Example 5: Multi-Format Tag Search

Find mobile-optimized creatives across multiple formats:

```json
{
  "filters": {
    "formats": ["display_320x50", "video_9x16_mobile", "display_300x250"],
    "tags_any": ["mobile_optimized", "responsive"],
    "status": "approved"
  },
  "sort": {
    "field": "updated_date",
    "direction": "desc"
  }
}
```

### Example 6: Lightweight Query with Specific Fields

Get minimal creative data for UI dropdown:

```json
{
  "fields": ["creative_id", "name", "format", "status"],
  "include_assignments": false,
  "filters": {
    "status": "approved"
  },
  "sort": {
    "field": "name",
    "direction": "asc"
  }
}
```

### Example 7: Native Ad Template Discovery

Find native ad templates with sub-assets:

```json
{
  "filters": {
    "formats": ["display_native_sponsored_post", "display_native_article"],
    "snippet_type": "html"
  },
  "include_sub_assets": true,
  "sort": {
    "field": "updated_date",
    "direction": "desc"
  }
}
```

### Example 8: Date Range Analysis

Analyze creative uploads over a specific quarter:

```json
{
  "filters": {
    "created_after": "2024-01-01T00:00:00Z",
    "created_before": "2024-03-31T23:59:59Z"
  },
  "include_performance": true,
  "sort": {
    "field": "created_date",
    "direction": "asc"
  },
  "pagination": {
    "limit": 100
  }
}
```

## Query Optimization Tips

### 1. Use Specific Filters
- Apply format filters early to narrow results
- Use status filters to focus on actionable creatives
- Combine multiple filters for precise targeting

### 2. Optimize Field Selection
- Use `fields` parameter to return only needed data
- Set `include_assignments: false` when assignment data isn't needed
- Only request performance data when analyzing creative effectiveness

### 3. Pagination Strategy
- Start with smaller page sizes (10-20) for interactive UI
- Use larger page sizes (50-100) for bulk processing
- Monitor `has_more` to implement efficient pagination

### 4. Sorting Considerations
- Sort by `created_date` for chronological browsing
- Sort by `performance_score` for effectiveness analysis
- Sort by `name` for alphabetical organization

## Filter Combinations

### Common Query Patterns

**Recent High-Performing Creatives:**
```json
{
  "filters": {
    "has_performance_data": true,
    "created_after": "2024-01-01T00:00:00Z"
  },
  "sort": { "field": "performance_score", "direction": "desc" },
  "include_performance": true
}
```

**Ready-to-Assign Creatives:**
```json
{
  "filters": {
    "status": "approved",
    "unassigned": true
  },
  "sort": { "field": "created_date", "direction": "desc" }
}
```

**Campaign-Specific Search:**
```json
{
  "filters": {
    "tags": ["q2_2024", "brand_awareness"],
    "formats": ["video", "display"]
  },
  "sort": { "field": "updated_date", "direction": "desc" }
}
```

## Error Handling

### Invalid Filter Values

When filters contain invalid values, specific errors are returned:

```json
{
  "message": "Query validation failed",
  "errors": [
    "Invalid snippet_type: 'invalid_type' must be one of [vast_xml, vast_url, html, javascript, iframe, daast_url]",
    "Invalid sort field: 'invalid_field' must be one of [created_date, updated_date, name, status, assignment_count, performance_score]"
  ]
}
```

### Large Result Sets

For queries returning very large result sets:

```json
{
  "message": "Query returned 10,000+ results, consider adding more specific filters",
  "query_summary": {
    "total_matching": 10247,
    "returned": 50
  }
}
```

## Performance Considerations

### 1. Filter Early
- Apply the most selective filters first
- Use format and status filters to reduce result sets
- Combine date ranges with other filters for efficiency

### 2. Paginate Appropriately  
- Avoid very large page sizes (>100) which may timeout
- Use offset-based pagination for consistent results
- Consider cursor-based pagination for very large libraries

### 3. Field Selection
- Request only needed fields using the `fields` parameter
- Avoid performance data inclusion unless analyzing metrics
- Use minimal field sets for dropdown/autocomplete scenarios

## Integration Patterns

### Creative Selection UI

```javascript
// Get lightweight creative list for dropdown
const response = await adcp.list_creatives({
  fields: ["creative_id", "name", "format"],
  filters: { status: "approved" },
  sort: { field: "name", direction: "asc" },
  include_assignments: false
});
```

### Performance Dashboard

```javascript
// Get top-performing creatives with metrics
const response = await adcp.list_creatives({
  filters: { 
    has_performance_data: true,
    created_after: "2024-01-01T00:00:00Z"
  },
  sort: { field: "performance_score", direction: "desc" },
  include_performance: true,
  pagination: { limit: 10 }
});
```

### Assignment Management

```javascript  
// Find unassigned creatives ready for new campaigns
const response = await adcp.list_creatives({
  filters: {
    unassigned: true,
    status: "approved",
    formats: ["video", "display"]
  },
  sort: { field: "created_date", direction: "desc" }
});
```

## Related Tasks

- [`sync_creatives`](./sync_creatives) - Upload and manage creative assets
- [`create_media_buy`](./create_media_buy) - Create campaigns using library creatives
- [`list_creative_formats`](./list_creative_formats) - Discover supported creative formats

---

*The list_creatives task provides powerful querying capabilities for the creative library, enabling efficient discovery, analysis, and management of creative assets across complex advertising workflows.*