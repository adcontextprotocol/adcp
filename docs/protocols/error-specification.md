---
sidebar_position: 6
title: Error Specification
---

# Error Specification

All AdCP operations use standardized error codes and structures for consistent error handling across protocols.

## Error Structure

```json
{
  "error": {
    "code": "invalid_parameter",
    "message": "Human-readable error description",
    "field": "budget",
    "suggestion": "How to fix the error",
    "details": { /* Additional context */ }
  }
}
```

## Error Codes

### Validation Errors
- `invalid_parameter` - Invalid parameter value
- `missing_required` - Required field missing  
- `constraint_violation` - Business rule violated

### Authentication/Authorization
- `authentication_failed` - Invalid credentials
- `permission_denied` - Insufficient permissions
- `principal_not_found` - Unknown principal

### Resource Errors  
- `not_found` - Resource doesn't exist
- `conflict` - Resource state conflict
- `expired` - Resource expired

### Business Logic
- `insufficient_budget` - Budget too low
- `inventory_unavailable` - No inventory
- `policy_violation` - Policy violation
- `approval_required` - Needs approval

### System Errors
- `internal_error` - Server error
- `platform_error` - Platform error
- `timeout` - Operation timeout
- `service_unavailable` - Service down

## Protocol Mappings

Each protocol maps AdCP error codes appropriately:

| AdCP Code | HTTP Status | JSON-RPC Code |
|-----------|-------------|---------------|
| `invalid_parameter` | 400 | -32602 |
| `authentication_failed` | 401 | -32001 |
| `permission_denied` | 403 | -32001 |
| `not_found` | 404 | -32601 |
| `internal_error` | 500 | -32603 |

See protocol-specific documentation for complete mappings.