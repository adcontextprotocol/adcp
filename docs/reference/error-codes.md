---
sidebar_position: 2
title: Error Codes
---

# Error Codes Reference

This page documents all standard error codes used across ACP implementations.

## Error Response Format

All errors follow this consistent structure:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "details": {
      // Additional context (optional)
    },
    "retry_after": 30  // Seconds to wait before retry (optional)
  }
}
```

## Authentication Errors

### INVALID_CREDENTIALS
Invalid or malformed authentication credentials.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "API key is invalid or has been revoked",
    "details": {
      "provided_key": "ak_live_123..."
    }
  }
}
```

**Resolution**: Verify API key is correct and active.

### TOKEN_EXPIRED
Authentication token has expired.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "TOKEN_EXPIRED", 
    "message": "OAuth token expired",
    "details": {
      "expired_at": "2025-01-20T10:30:00Z"
    }
  }
}
```

**Resolution**: Refresh OAuth token or re-authenticate.

### INSUFFICIENT_PERMISSIONS
Account lacks required permissions for the operation.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_PERMISSIONS",
    "message": "Account does not have activation permissions",
    "details": {
      "required_permission": "activate_signal",
      "account_permissions": ["get_signals", "check_signal_status"]
    }
  }
}
```

**Resolution**: Contact administrator to upgrade account permissions.

## Validation Errors

### MISSING_REQUIRED_FIELD
Required request parameter is missing.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "MISSING_REQUIRED_FIELD",
    "message": "prompt is required for signal discovery",
    "details": {
      "field": "prompt",
      "provided_fields": ["platform", "max_results"]
    }
  }
}
```

**Resolution**: Include all required fields in request.

### INVALID_FIELD_VALUE
Field value doesn't meet validation requirements.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "INVALID_FIELD_VALUE",
    "message": "max_results must be between 1 and 50",
    "details": {
      "field": "max_results",
      "provided_value": 100,
      "valid_range": "1-50"
    }
  }
}
```

**Resolution**: Provide valid field values per specification.

### INVALID_FIELD_FORMAT
Field format is incorrect.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "INVALID_FIELD_FORMAT",
    "message": "reporting_date must be in YYYY-MM-DD format",
    "details": {
      "field": "reporting_date",
      "provided_value": "01/20/2025",
      "expected_format": "YYYY-MM-DD"
    }
  }
}
```

**Resolution**: Use correct field format as specified.

## Resource Errors

### SEGMENT_NOT_FOUND
Specified segment ID doesn't exist or is no longer available.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "SEGMENT_NOT_FOUND",
    "message": "Segment ID not found or has expired",
    "details": {
      "segment_id": "seg_invalid_123",
      "suggestion": "Use get_signals to find current segment IDs"
    }
  }
}
```

**Resolution**: Use current segment ID from recent `get_signals` response.

### SIGNAL_UNAVAILABLE
Signal exists but is not available for the requested platform/seat.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "SIGNAL_UNAVAILABLE",
    "message": "Signal not available for the specified platform",
    "details": {
      "segment_id": "seg_12345",
      "requested_platform": "unavailable_platform",
      "available_platforms": ["scope3", "thetradedesk"]
    }
  }
}
```

**Resolution**: Use available platform or check with provider.

## Authorization Errors

### PLATFORM_UNAUTHORIZED
Account lacks access to specified platform.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "PLATFORM_UNAUTHORIZED",
    "message": "Account not authorized for platform",
    "details": {
      "requested_platform": "restricted_platform",
      "authorized_platforms": ["scope3", "liveramp"]
    }
  }
}
```

**Resolution**: Use authorized platform or upgrade account access.

### SEAT_UNAUTHORIZED
Account cannot access specified seat.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "SEAT_UNAUTHORIZED",
    "message": "Account cannot access seat",
    "details": {
      "requested_seat": "competitor_seat_001",
      "authorized_seats": ["brand_us_001", "brand_emea_002"]
    }
  }
}
```

**Resolution**: Use authorized seat or request access.

## Operation Errors

### ALREADY_ACTIVATED
Signal is already active for the specified platform/seat.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "ALREADY_ACTIVATED",
    "message": "Signal already activated for this platform and seat",
    "details": {
      "segment_id": "seg_12345",
      "platform": "scope3",
      "seat": "brand_us_001",
      "activated_at": "2025-01-15T10:30:00Z",
      "status": "deployed"
    }
  }
}
```

**Resolution**: Use existing activation or check status with `check_signal_status`.

### ACTIVATION_FAILED
Signal activation process failed.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "ACTIVATION_FAILED",
    "message": "Failed to activate signal due to provider error",
    "details": {
      "segment_id": "seg_12345",
      "provider_error": "Segment temporarily unavailable",
      "retry_suggested": true
    },
    "retry_after": 300
  }
}
```

**Resolution**: Wait and retry, or contact support if persistent.

### INVALID_PRICING_MODEL
Requested pricing model is not available for this signal.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "INVALID_PRICING_MODEL",
    "message": "CPM pricing not available for this signal",
    "details": {
      "segment_id": "seg_12345",
      "requested_model": "cpm",
      "available_models": ["revenue_share"]
    }
  }
}
```

**Resolution**: Use available pricing model or choose different signal.

## Schema Version Errors

### UNSUPPORTED_VERSION
Requested AdCP schema version is not supported by the server.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "UNSUPPORTED_VERSION",
    "message": "AdCP version '2.1.0' is not supported. Server supports versions compatible with 1.0.0 per semantic versioning.",
    "details": {
      "requested_version": "2.1.0",
      "current_server_version": "1.0.0",
      "compatibility_info": "Use versions 1.x.x for backward compatibility"
    }
  }
}
```

**Resolution**: Use a compatible schema version or upgrade to a server that supports the requested version.

## Rate Limiting Errors

### RATE_LIMIT_EXCEEDED
Too many requests within the rate limit window.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Rate limit: 100 requests per minute",
    "details": {
      "limit": 100,
      "window": "60 seconds",
      "reset_time": "2025-01-20T15:31:00Z"
    },
    "retry_after": 45
  }
}
```

**Resolution**: Wait for rate limit window to reset before retrying.

## System Errors

### INTERNAL_SERVER_ERROR
Unexpected server error occurred.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "An internal error occurred while processing the request",
    "details": {
      "request_id": "req_789123456",
      "timestamp": "2025-01-20T15:30:00Z"
    }
  }
}
```

**Resolution**: Retry request. Contact support if error persists.

### SERVICE_UNAVAILABLE
External service dependency is temporarily unavailable.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "SERVICE_UNAVAILABLE", 
    "message": "Data provider service is temporarily unavailable",
    "details": {
      "provider": "LiveRamp",
      "estimated_recovery": "2025-01-20T16:00:00Z"
    },
    "retry_after": 900
  }
}
```

**Resolution**: Wait for service recovery and retry.

### TIMEOUT
Request exceeded maximum processing time.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "TIMEOUT",
    "message": "Request exceeded 30 second timeout",
    "details": {
      "timeout_seconds": 30,
      "suggestion": "Try a more specific prompt or contact support"
    }
  }
}
```

**Resolution**: Refine request parameters or retry.

## Data Errors

### DATA_QUALITY_ISSUE
Data quality problem detected.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "DATA_QUALITY_ISSUE",
    "message": "Signal size data is stale",
    "details": {
      "segment_id": "seg_12345",
      "last_updated": "2024-12-01T00:00:00Z",
      "max_age_days": 30
    }
  }
}
```

**Resolution**: Contact provider for updated signal data.

### USAGE_REPORT_REJECTED
Usage report failed validation.

**Example**:
```json
{
  "success": false,
  "error": {
    "code": "USAGE_REPORT_REJECTED",
    "message": "Negative impression count not allowed",
    "details": {
      "segment_id": "seg_12345",
      "field": "impressions",
      "provided_value": -1000,
      "validation_rule": "must be >= 0"
    }
  }
}
```

**Resolution**: Correct data and resubmit usage report.

## Error Handling Best Practices

### Retry Logic

Implement exponential backoff for retryable errors:

```typescript
async function retryRequest(fn: Function, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error.code === 'RATE_LIMIT_EXCEEDED' && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}
```

### Error Categorization

Group errors by type for appropriate handling:

```typescript
const RETRYABLE_ERRORS = [
  'RATE_LIMIT_EXCEEDED',
  'TIMEOUT', 
  'SERVICE_UNAVAILABLE',
  'INTERNAL_SERVER_ERROR'
];

const PERMANENT_ERRORS = [
  'INVALID_CREDENTIALS',
  'INSUFFICIENT_PERMISSIONS',
  'SEGMENT_NOT_FOUND',
  'PLATFORM_UNAUTHORIZED',
  'UNSUPPORTED_VERSION'
];

function isRetryable(errorCode: string): boolean {
  return RETRYABLE_ERRORS.includes(errorCode);
}
```

### User-Friendly Messages

Convert technical errors to user-friendly messages:

```typescript
const USER_MESSAGES = {
  'SEGMENT_NOT_FOUND': 'This signal is no longer available. Please search for signals again.',
  'RATE_LIMIT_EXCEEDED': 'Too many requests. Please wait a moment and try again.',
  'INSUFFICIENT_PERMISSIONS': 'Your account does not have permission for this action. Contact your administrator.',
  'UNSUPPORTED_VERSION': 'The requested schema version is not supported. Please use a compatible version.',
  // ... more mappings
};

function getUserMessage(errorCode: string): string {
  return USER_MESSAGES[errorCode] || 'An unexpected error occurred. Please try again.';
}
```

## Getting Help

If you encounter errors not documented here:

1. **Check the details field** for additional context
2. **Review request format** against the specification
3. **Contact platform support** with the request_id if provided
4. **Report new error patterns** to help improve documentation

For technical support: support@adcontextprotocol.org