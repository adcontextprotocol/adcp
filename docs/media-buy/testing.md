# Testing and Development

## Overview

AdCP servers support time simulation and dry run capabilities to enable comprehensive testing of advertising workflows without waiting for real-time events or spending actual budgets.

## Protocol Compliance Testing

Use the [AdCP Protocol Test Harness](https://storylab.scope3.com/sales-agents) to validate your implementation's compliance with the AdCP specification. This interactive tool allows you to test all AdCP tasks and verify correct behavior across different scenarios.

## Testing Modes

### Dry Run Mode

Execute all operations without affecting real platforms or spending money:

```http
X-Dry-Run: true
```

When dry run mode is enabled:
- No real platform API calls are made
- No actual money is spent
- Responses indicate test mode is active
- All operations return simulated but realistic results

### Time Simulation Mode

Control simulated time to instantly progress through campaign events:

```http
X-Mock-Time: 2025-01-01T09:00:00Z
X-Auto-Advance: true
```

Time simulation headers:
- `X-Mock-Time`: Set current simulated time
- `X-Auto-Advance`: Auto-advance to next event
- `X-Jump-To-Event`: Jump to specific campaign event

## Request Headers

### Testing Control Headers

```http
X-Dry-Run: <boolean>             # Enable dry run mode
X-Test-Session-ID: <string>      # Isolate parallel test sessions
X-Mock-Time: <ISO-8601>          # Set current simulated time
X-Auto-Advance: <boolean>        # Auto-advance to next event
X-Jump-To-Event: <event_name>    # Jump to specific event (lifecycle or error)
```

### Response Headers

Servers include these headers in test mode responses:

```http
X-Dry-Run: true                  # Confirms dry run mode active
X-Test-Session-ID: <string>      # Test session identifier
X-Mock-Time: <ISO-8601>          # Current simulated time
X-Next-Event: <event_name>       # Next scheduled event
X-Next-Event-Time: <ISO-8601>    # When next event occurs
X-Simulated-Spend: <decimal>     # Simulated advertising spend so far
```

## Event Progression

### Jumpable Events

Use `X-Jump-To-Event` to jump to specific campaign lifecycle events:

**Lifecycle Events**:
- `campaign_created` - Initial setup complete
- `campaign_approved` - Ready for creative submission
- `creative_approved` - Ready for launch
- `campaign_launched` - Live delivery begins
- `campaign_50_percent` - Halfway through schedule
- `campaign_completed` - Natural end reached

**Error Events**:
- `creative_policy_violation` - Force creative rejection
- `budget_exceeded` - Simulate overspend
- `inventory_unavailable` - Simulate inventory shortage
- `manual_approval_delay` - Add HITL approval delay

### Time Advancement

Jump forward by duration:

```http
X-Advance-Time: 7d
```

Or advance to next significant event:

```http
X-Auto-Advance: true
```

## Testing Examples

### Example: Testing Creative Rejection

```json
POST /sync_creatives
Headers: {
  "X-Dry-Run": "true",
  "X-Jump-To-Event": "creative_policy_violation"
}

Response: {
  "status": "rejected",
  "dry_run": true,
  "errors": [{
    "code": "POLICY_VIOLATION",
    "message": "Creative violates policy (test event)"
  }]
}
```

### Example: Testing Time Progression

```json
POST /create_media_buy
Headers: {
  "X-Dry-Run": "true",
  "X-Mock-Time": "2025-01-01T09:00:00Z"
}

Response: {
  "media_buy_id": "mb_test_123",
  "status": "pending_approval",
  "dry_run": true,
  "simulated_time": "2025-01-01T09:00:00Z"
}

GET /get_media_buy_delivery?media_buy_id=mb_test_123
Headers: {
  "X-Dry-Run": "true",
  "X-Jump-To-Event": "campaign_50_percent"
}

Response: {
  "media_buy_id": "mb_test_123",
  "dry_run": true,
  "simulated_time": "2025-01-15T09:00:00Z",
  "metrics": {
    "impressions": 350000,
    "spend": 5000.00,
    "pacing": "on_track"
  }
}
```

## Testing Patterns

### Pattern 1: Happy Path Testing

Test successful campaign flows without forcing errors:

```http
X-Dry-Run: true
X-Mock-Time: 2025-01-01T00:00:00Z
```

### Pattern 2: Error Recovery Testing

Test error handling by jumping to error events:

```http
X-Dry-Run: true
X-Jump-To-Event: creative_policy_violation
```

Then test recovery:

```http
X-Dry-Run: true
X-Jump-To-Event: creative_approved
```

### Pattern 3: Time-Based Testing

Test long-running campaigns quickly:

```http
X-Dry-Run: true
X-Mock-Time: 2025-01-01T00:00:00Z
X-Auto-Advance: true
```

Each request advances to the next significant event.

### Pattern 4: Parallel Testing

Test multiple campaigns in isolated sessions:

```http
// Test Session A - Normal flow
POST /create_media_buy
Headers: {
  "X-Dry-Run": "true",
  "X-Test-Session-ID": "test-session-a",
  "X-Mock-Time": "2025-01-01T00:00:00Z"
}

// Test Session B - Force error (different session)
POST /create_media_buy
Headers: {
  "X-Dry-Run": "true",
  "X-Test-Session-ID": "test-session-b",
  "X-Jump-To-Event": "budget_exceeded"
}
```

Each test session maintains its own isolated state, allowing parallel testing without interference.

## Implementation Requirements

### Core Requirements

All AdCP implementations MUST support:

1. **Dry Run Mode**
   - `X-Dry-Run` header recognition
   - No side effects on production systems
   - Clear indication of test mode in responses

2. **Test Session Isolation**
   - `X-Test-Session-ID` for parallel test isolation
   - Independent state per session
   - No cross-session interference

3. **Basic Time Control**
   - `X-Mock-Time` for setting simulated time
   - `X-Jump-To-Event` for event progression
   - Consistent state across time jumps

### Recommended Features

Implementations SHOULD support:

1. **Auto-Advancement**
   - `X-Auto-Advance` for automatic progression
   - `X-Advance-Time` for duration-based jumps

2. **Error Events**
   - Jump to error states via `X-Jump-To-Event`
   - Common error events (policy violations, budget issues)
   - Recovery testing

### Optional Features

Implementations MAY support:

1. **Advanced Testing**
   - Custom event definitions
   - Complex error injection
   - Performance simulation

2. **Detailed Metrics**
   - Realistic performance curves
   - Industry benchmark simulation
   - Cost modeling

## Security Considerations

- Test modes MUST be completely isolated from production
- Test mode operations should be logged separately
- Authentication is still required in test mode
- Rate limits apply (potentially with different thresholds)

## Summary

AdCP testing features enable:

1. **Rapid Development** - Test full lifecycles in seconds
2. **Comprehensive Testing** - Cover all scenarios deterministically
3. **Zero Cost** - No real money spent on testing
4. **Isolation** - Complete separation from production

Use HTTP headers to control test behavior, not special naming conventions or separate APIs. This keeps testing orthogonal to business logic and maintains clean separation of concerns.