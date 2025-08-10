---
sidebar_position: 8
title: Response Specification
---

# Response Specification

AdCP defines standard response formats for all operations.

## Response Structure

All successful responses include:

```json
{
  "message": "Human-readable summary (always present)",
  "context_id": "ctx-abc123",
  "data": { /* Operation-specific data */ },
  "metadata": { /* Optional metadata */ }
}
```

## Response Patterns by Operation Type

### Entity Operations
Always include structured data:

```json
{
  "message": "Found 5 products matching criteria",
  "context_id": "ctx-123",
  "data": {
    "products": [...]
  },
  "metadata": {
    "total_count": 5,
    "query_interpretation": {
      "original": "video ads",
      "interpreted_as": "format:video"
    }
  }
}
```

### Status Operations
Include both message and data:

```json
{
  "message": "Media buy MB-123 created successfully",
  "context_id": "ctx-456",
  "data": {
    "media_buy_id": "MB-123",
    "status": "pending_creatives",
    "creative_deadline": "2025-01-20T23:59:59Z"
  }
}
```

### Informational Queries
May include only message:

```json
{
  "message": "All campaigns are running normally",
  "context_id": "ctx-789"
}
```

## Metadata Fields

Common metadata fields:

```typescript
interface ResponseMetadata {
  // Pagination
  total_count?: number;
  returned_count?: number;
  has_more?: boolean;
  next_cursor?: string;
  
  // Query understanding
  query_interpretation?: {
    original: string;
    interpreted_as: string;
    confidence: number;
  };
  
  // Performance
  response_time_ms?: number;
  cache_hit?: boolean;
  
  // Suggestions
  suggestions?: string[];
  related?: string[];
}
```

## Progress Updates

Long-running operations report progress:

```json
{
  "task_id": "task-123",
  "status": "processing",
  "progress": {
    "current": 3,
    "total": 5,
    "percentage": 60,
    "message": "Creating campaign in ad server..."
  },
  "estimated_completion": "2025-01-15T10:05:00Z"
}
```

## Message Field Guidelines

The `message` field should:
- Summarize the result in natural language
- Include key numbers and IDs
- Suggest next steps when appropriate
- Be self-contained (understandable without data)

Good examples:
- ✅ "Created media buy MB-12345 with $50,000 budget"
- ✅ "Found 12 products with CPMs from $15-45"

Bad examples:
- ❌ "Success"
- ❌ "Operation completed"