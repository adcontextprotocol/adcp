---
sidebar_position: 4
title: Error Handling
---

# Error Handling Across Protocols

This document outlines AdCP's approach to error handling across MCP and A2A protocols, providing consistent patterns for both fatal errors and non-fatal warnings.

## Philosophy

### Pending States vs Errors

**Pending States (Normal Flow):**
- `pending`: Request received and queued
- `processing`: Operation in progress  
- `pending_manual`: Operation requires human approval
- `pending_permission`: Operation blocked by permissions
- `pending_approval`: Awaiting ad server approval

These are NOT errors and should be handled as part of normal operation flow.

**Error States (Exceptional):**
- Task-level failures that prevent completion
- Authentication failures 
- Invalid parameters
- Resource not found
- Authorization denied

### Error Response Patterns

AdCP uses a two-tier error handling approach:

1. **Task-Level Errors (Non-Fatal)**: Warnings and issues that don't prevent operation completion
2. **Protocol-Level Errors (Fatal)**: Operations that cannot be completed

## Task-Level Error Handling

### Non-Fatal Errors vs Warnings

AdCP distinguishes between two types of task-level issues:

**Non-Fatal Errors**: Actual failures that prevented part of the request from being fulfilled. These go in the `errors` array:

```json
{
  "message": "Signal discovery completed with partial results",
  "adcp_version": "1.0.0",
  "context_id": "ctx-123",
  "signals": [/* available signals */],
  "errors": [
    {
      "code": "NO_DATA_IN_REGION",
      "message": "No signal data available for requested region: Australia",
      "field": "deliver_to.countries[1]",
      "suggestion": "Remove Australia from target countries or contact data provider for coverage expansion",
      "details": {
        "requested_country": "AU",
        "available_countries": ["US", "CA", "GB", "DE"],
        "data_provider": "Peer39"
      }
    }
  ]
}
```

**Warnings**: Advisory information about configuration, timing, or data quality. These are communicated only in the `message` field:

```json
{
  "message": "Signal activation successful. Note that your account frequency cap settings are set conservatively and may limit reach. Contact your account manager to review frequency cap settings for optimal performance.",
  "adcp_version": "1.0.0", 
  "context_id": "ctx-456",
  "task_id": "activation_789",
  "status": "deployed",
  "decisioning_platform_segment_id": "pm_brand456_peer39_lux_auto",
  "deployed_at": "2025-01-15T14:30:00Z"
}
```

### Partial Success Support

Tasks can succeed while returning non-fatal errors in the `errors` array or warnings in the `message` field:

**Non-Fatal Errors (partial failures in `errors` array):**
- **Discovery tasks**: Can find some results while reporting regions/platforms with no data
- **Activation tasks**: Can activate on some platforms while failing on others
- **Creation tasks**: Can create some packages while others fail validation

**Warnings (advisory information in `message` field):**
- **Discovery tasks**: Can find results while noting data freshness or coverage limitations in the message
- **Activation tasks**: Can activate successfully while noting suboptimal configuration in the message
- **Creation tasks**: Can create resources while suggesting optimization opportunities in the message

### Error Object Structure

The `errors` array contains error objects for actual failures:

```json
{
  "code": "ERROR_CODE",           // Required: Standardized error code
  "message": "Description",       // Required: Human-readable message
  "field": "field.path",         // Optional: Which field has the issue
  "suggestion": "Try this",      // Optional: Actionable remediation steps
  "details": {                   // Optional: Additional context
    "affected_items": ["id1"],
    "retry_after": 1800
  }
}
```

### Warning Communication

Warnings and advisory information should be communicated in the human-readable `message` field rather than cluttering the `errors` array. This keeps the `errors` array focused on actionable failures that require programmatic handling.

## Protocol-Level Error Handling

### MCP (Model Context Protocol)

For fatal errors that prevent task completion, MCP uses the `isError: true` pattern:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Failed to activate signal: Account 'brand-456-pm' not authorized for Peer39 data on PubMatic. Contact your PubMatic account manager to enable access."
      }
    ],
    "isError": true
  }
}
```

**When to use MCP fatal errors:**
- Authentication failures
- Invalid tool parameters  
- Resource not found
- Authorization denied
- System errors

### A2A (Agent-to-Agent Protocol)

For fatal errors, A2A uses the `status: "failed"` pattern:

```json
{
  "taskId": "task_123",
  "status": "failed",
  "message": {
    "parts": [{
      "kind": "text",
      "text": "Unable to complete signal activation: Invalid signal agent segment ID 'seg_invalid_123'. Use get_signals to find current segment IDs."
    }]
  }
}
```

**When to use A2A fatal errors:**
- Skill execution failures
- Invalid request parameters
- External service unavailable
- Authentication issues

## Error Recovery Strategies

### Retry Logic

- **Check `retry_after` field** for appropriate retry timing
- **Implement exponential backoff** for rate limiting and service issues
- **Categorize errors** by retry-ability (permanent vs temporary)

```typescript
const RETRYABLE_ERRORS = [
  'RATE_LIMIT_EXCEEDED',
  'TIMEOUT', 
  'SERVICE_UNAVAILABLE',
  'ACTIVATION_FAILED'  // May succeed on retry
];

const PERMANENT_ERRORS = [
  'INVALID_CREDENTIALS',
  'INSUFFICIENT_PERMISSIONS',
  'SIGNAL_AGENT_SEGMENT_NOT_FOUND',
  'PLATFORM_UNAUTHORIZED'
];
```

### Actionable Feedback

- **Use `suggestion` field** to guide remediation steps
- **Include relevant context** in `details` object for debugging
- **Provide specific field paths** for validation errors
- **Reference external resources** when additional action is required

### Context Preservation

- **Use `context_id`** for session management across related operations
- **Include `task_id`** for asynchronous operation tracking
- **Preserve request context** in error details for debugging

## Implementation Guidelines

### Error Message Construction

**Good error messages:**
- Explain what went wrong and why
- Provide specific remediation steps
- Include relevant context (IDs, values, constraints)
- Use clear, non-technical language

**Example:**
```json
{
  "code": "TARGETING_TOO_NARROW",
  "message": "Package targeting yielded 0 available impressions",
  "field": "packages[1].targeting_overlay",
  "suggestion": "Broaden geographic targeting or remove segment exclusions",
  "details": {
    "requested_budget": 40000,
    "available_impressions": 0,
    "affected_package": "nike_audio_drive_package"
  }
}
```

### Error Code Naming

- Use `SCREAMING_SNAKE_CASE` format
- Be specific and descriptive
- Group by category (ACTIVATION_, TARGETING_, PRICING_, etc.)
- Avoid generic codes like `ERROR` or `FAILED`

### Validation Error Patterns

For field validation issues:

```json
{
  "code": "INVALID_FIELD_VALUE",
  "message": "Budget must be between $1,000 and $1,000,000",
  "field": "packages[0].budget.total",
  "suggestion": "Adjust budget to be within allowed range",
  "details": {
    "provided_value": 500,
    "min_value": 1000,
    "max_value": 1000000,
    "currency": "USD"
  }
}
```

## Common Error Scenarios

### Authentication & Authorization

- **Invalid credentials**: Protocol-level fatal error
- **Insufficient permissions**: Protocol-level fatal error  
- **Account restrictions**: Task-level warning with limited functionality

### Resource Management

- **Resource not found**: Protocol-level fatal error
- **Resource unavailable**: Task-level warning with alternatives
- **Resource limitations**: Task-level warning with impact description

### Data Quality Issues

- **Invalid input data**: Protocol-level fatal error
- **Stale data**: Task-level warning communicated in message field
- **Incomplete data**: Task-level warning communicated in message field

## Testing Error Scenarios

When implementing AdCP tasks, test these error scenarios:

1. **Invalid authentication** → Protocol-level fatal
2. **Missing required fields** → Protocol-level fatal  
3. **Field validation failures** → Protocol-level fatal
4. **Resource limitations** → Task-level warnings in message field
5. **Partial data issues** → Task-level warnings in message field
6. **Service degradation** → Task-level warnings in message field with retry guidance

## Reference

- [Error Codes Reference](../reference/error-codes.md) - Complete list of standardized error codes
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#error-handling) - Official MCP error handling
- [A2A Protocol Guide](./a2a-guide.md) - A2A-specific error patterns