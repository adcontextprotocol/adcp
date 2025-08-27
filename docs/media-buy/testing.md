# Testing and Development

## Overview

AdCP servers support time simulation and dry run capabilities to enable comprehensive testing of advertising workflows without waiting for real-time events or spending actual budgets.

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
X-Mock-Time: <ISO-8601>          # Set current simulated time
X-Auto-Advance: <boolean>        # Auto-advance to next event
X-Jump-To-Event: <event_name>    # Jump to specific event
X-Test-Scenario: <scenario>      # Trigger test scenarios
X-Strategy-Id: <string>          # Optional: Link related operations
```

### Response Headers

Servers include these headers in test mode responses:

```http
X-Dry-Run-Mode: true             # Confirms dry run active
X-Current-Mock-Time: <ISO-8601>  # Current simulated time
X-Next-Event: <event_name>       # Next scheduled event
X-Next-Event-Time: <ISO-8601>    # When next event occurs
X-Simulated-Cost: <decimal>      # Would-be cost (dry run)
```

## Event Progression

### Jumpable Events

Use `X-Jump-To-Event` to jump to specific campaign lifecycle events:

**Campaign Events**:
- `campaign_created` - Initial setup complete
- `campaign_approved` - Ready for creative submission
- `creative_approved` - Ready for launch
- `campaign_launched` - Live delivery begins
- `campaign_50_percent` - Halfway through schedule
- `campaign_completed` - Natural end reached

**Error Events**:
- `creative_policy_violation` - Creative needs revision
- `budget_exceeded` - Overspend occurred
- `inventory_unavailable` - Inventory shortage

### Time Advancement

Jump forward by duration:

```http
X-Advance-Time: 7d
```

Or advance to next significant event:

```http
X-Auto-Advance: true
```

## Test Scenarios

### Predefined Scenarios

Use `X-Test-Scenario` to trigger specific test behaviors:

- `happy_path` - Everything works perfectly
- `creative_rejection` - Creative policy violation
- `budget_exceeded` - Overspend scenario
- `manual_approval_delay` - HITL approval takes 48 hours
- `inventory_shortage` - Limited inventory available

### Example: Testing Creative Rejection

```json
POST /add_creative_assets
Headers: {
  "X-Dry-Run": "true",
  "X-Test-Scenario": "creative_rejection"
}

Response: {
  "status": "rejected",
  "dry_run": true,
  "errors": [{
    "code": "POLICY_VIOLATION",
    "message": "Creative violates policy (test scenario)"
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

Test successful campaign flows:

```http
X-Dry-Run: true
X-Test-Scenario: happy_path
```

### Pattern 2: Error Recovery Testing

Test error handling:

```http
X-Dry-Run: true
X-Test-Scenario: creative_rejection
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

Test multiple campaigns with different scenarios by using different strategy IDs:

```json
// Campaign A
{
  "strategy_id": "test_campaign_a",
  "headers": {
    "X-Dry-Run": "true",
    "X-Test-Scenario": "happy_path"
  }
}

// Campaign B
{
  "strategy_id": "test_campaign_b",
  "headers": {
    "X-Dry-Run": "true",
    "X-Test-Scenario": "budget_exceeded"
  }
}
```

## Implementation Requirements

### Core Requirements

All AdCP implementations MUST support:

1. **Dry Run Mode**
   - `X-Dry-Run` header recognition
   - No side effects on production systems
   - Clear indication of test mode in responses

2. **Basic Time Control**
   - `X-Mock-Time` for setting simulated time
   - `X-Jump-To-Event` for event progression
   - Consistent state across time jumps

### Recommended Features

Implementations SHOULD support:

1. **Test Scenarios**
   - `X-Test-Scenario` for predefined behaviors
   - Common error scenarios
   - Recovery testing

2. **Auto-Advancement**
   - `X-Auto-Advance` for automatic progression
   - `X-Advance-Time` for duration-based jumps

### Optional Features

Implementations MAY support:

1. **Advanced Scenarios**
   - Custom test scenario definitions
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