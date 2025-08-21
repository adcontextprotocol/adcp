# Testing and Development

## Overview

AdCP servers support time simulation and dry run capabilities to enable comprehensive testing of advertising agents and campaigns without waiting for real-time events or spending actual budgets.

## Problem Statement

Advertising campaigns have inherently long lifecycles that make testing AdCP client implementations impractical:

- **Creative Review**: 2-48 hours for platform approval
- **Learning Phases**: 3-7 days for algorithm optimization
- **Full Campaigns**: 30-90 days typical duration
- **Budget Cycles**: Daily, weekly, or monthly spend patterns

Current testing challenges include:

1. **Time Constraints**: Developers cannot wait days/weeks to test campaign lifecycle handling
2. **Cost Barriers**: Testing with real campaigns costs money and affects real ad delivery
3. **Event Coverage**: Rare events (budget exhaustion, policy violations) are hard to trigger naturally
4. **Regression Testing**: Automated tests need deterministic, fast execution
5. **Demo Scenarios**: Sales demos and training need to show full lifecycles quickly

## Testing Modes

AdCP servers provide two complementary testing modes:

### 1. Time Simulation Mode
Control simulated time to instantly progress through campaign events while maintaining realistic state transitions and metrics.

### 2. Dry Run Mode
Execute all operations without affecting real platforms or spending money, while providing realistic responses and behaviors.

## Technical Specification

### Request Headers

```http
X-Mock-Time: <ISO-8601>          # Set current simulated time
X-Auto-Advance: <boolean>        # Auto-advance to next event
X-Jump-To-Event: <event_name>    # Jump to specific event
X-Dry-Run: <boolean>             # Enable dry run mode
X-Test-Scenario: <scenario>      # Trigger test scenarios
```

### Response Headers

```http
X-Current-Mock-Time: <ISO-8601>  # Current simulated time
X-Next-Event: <event_name>       # Next scheduled event
X-Next-Event-Time: <ISO-8601>    # When next event occurs
X-Dry-Run-Mode: <boolean>        # Confirms dry run active
X-Simulated-Cost: <decimal>      # Would-be cost (dry run)
```

### Jumpable Events

Standard events that can be jumped to via `X-Jump-To-Event`:

#### Creative Lifecycle
- `creatives_uploaded` - Assets received by platform
- `creatives_processing` - Platform processing assets
- `creatives_processed` - Processing complete
- `creative_review_started` - Policy review initiated
- `creative_review_complete` - Review finished
- `creative_approved` - Approved for delivery
- `creative_rejected` - Failed policy review

#### Campaign Lifecycle
- `campaign_created` - Initial setup complete
- `campaign_approved` - Ready to start delivery
- `campaign_started` - Delivery begins
- `learning_phase_started` - Algorithm optimization begins
- `learning_phase_complete` - Optimization stable
- `campaign_paused` - Temporarily stopped
- `campaign_resumed` - Restarted after pause
- `campaign_ended` - Natural completion

#### Performance Events
- `first_impression` - Initial ad served
- `first_click` - Initial engagement
- `first_conversion` - Initial success metric
- `optimization_applied` - Algorithm adjustment made
- `performance_plateau` - Metrics stabilized

#### Budget Events
- `budget_10_percent` - 10% spent
- `budget_25_percent` - 25% spent
- `budget_50_percent` - 50% spent
- `budget_75_percent` - 75% spent
- `budget_90_percent` - 90% spent (pace warning)
- `budget_exhausted` - 100% spent

#### Error Events
- `policy_violation` - Content policy issue
- `payment_failed` - Billing problem
- `platform_error` - Technical issue
- `account_suspended` - Access revoked

### Test Scenarios

Pre-defined scenarios accessible via `X-Test-Scenario`:

#### Success Scenarios
- `success_campaign` - Normal progression, achieves target CPA
- `high_performance` - Exceeds KPI targets significantly
- `gradual_optimization` - Slow but steady improvement

#### Failure Scenarios
- `policy_violation` - Creative rejected, requires revision
- `learning_failure` - Insufficient conversions, optimization struggles
- `budget_exhaustion` - Rapid spend without conversions
- `account_suspension` - Mid-campaign account issue

#### Edge Cases
- `intermittent_delivery` - Start-stop patterns
- `seasonal_variation` - Time-based performance changes
- `competitive_pressure` - Auction dynamics simulation

## API Examples

### Example 1: Test Full Campaign Lifecycle

```python
# Create campaign in dry run mode
POST /create_media_buy
Headers: {
  "X-Dry-Run": "true",
  "X-Mock-Time": "2025-01-01T09:00:00Z"
}
Body: {
  "name": "Test Campaign",
  "budget": 1000.00,
  "products": ["prod_123"],
  "schedule": {
    "start_date": "2025-01-01",
    "end_date": "2025-01-31"
  }
}

Response: {
  "media_buy_id": "mb_test_123",
  "status": "pending_approval",
  "dry_run": true,
  "simulated_time": "2025-01-01T09:00:00Z",
  "next_event": "campaign_approved",
  "next_event_time": "2025-01-01T11:00:00Z"
}

# Jump to learning phase complete
GET /get_media_buy_delivery?media_buy_id=mb_test_123
Headers: {
  "X-Dry-Run": "true",
  "X-Jump-To-Event": "learning_phase_complete"
}

Response: {
  "media_buy_id": "mb_test_123",
  "status": "active",
  "dry_run": true,
  "simulated_time": "2025-01-06T09:00:00Z",
  "learning_phase": {
    "status": "complete",
    "duration_days": 5,
    "conversions_gathered": 50
  },
  "metrics": {
    "impressions": 50000,
    "clicks": 500,
    "conversions": 50,
    "simulated_spend": 500.00,
    "cpa": 10.00
  }
}
```

### Example 2: Test Error Scenarios

```python
# Trigger policy violation scenario
POST /add_creative_assets
Headers: {
  "X-Dry-Run": "true",
  "X-Test-Scenario": "policy_violation"
}
Body: {
  "media_buy_id": "mb_test_123",
  "assets": [...]
}

Response: {
  "status": "rejected",
  "dry_run": true,
  "errors": [{
    "code": "POLICY_VIOLATION",
    "message": "Misleading claims detected (simulated)",
    "field": "headline",
    "policy_link": "https://platform.example/policies/claims"
  }],
  "simulated_review_time": "2 hours"
}
```

### Example 3: Auto-Advance Through Timeline

```python
# Create and auto-advance through events
POST /create_media_buy
Headers: {
  "X-Dry-Run": "true",
  "X-Mock-Time": "2025-01-01T09:00:00Z",
  "X-Auto-Advance": "true"
}

# Each subsequent request auto-advances time
GET /get_media_buy_delivery?media_buy_id=mb_test_123
Headers: {
  "X-Dry-Run": "true",
  "X-Auto-Advance": "true"
}

Response: {
  "simulated_time": "2025-01-01T11:00:00Z",  # Advanced 2 hours
  "event_occurred": "campaign_approved",
  "next_event": "campaign_started",
  "next_event_time": "2025-01-02T00:00:00Z"
}
```

## Implementation Guidelines

### State Management

Implementations should maintain separate state for test modes:

```python
class MediaBuyState:
    def __init__(self, dry_run=False):
        self.dry_run = dry_run
        self.simulated_time = None
        self.events_timeline = []
        self.metrics_curve = None
        
    def advance_to_event(self, event_name):
        # Progress state to match event
        # Update metrics realistically
        # Maintain consistency
```

### Realistic Metrics

Simulated metrics should follow realistic patterns:

```python
def generate_metrics(time_elapsed, budget, targeting):
    # S-curve for learning phase
    # Daily fluctuations for seasonality
    # Competitive factors for CPM variations
    # Conversion lag for attribution
```

### Webhook Simulation

In dry run mode, webhooks should be queued but not delivered:

```json
{
  "webhook_queue": [
    {
      "event": "campaign.started",
      "scheduled_time": "2025-01-02T00:00:00Z",
      "payload": {...},
      "would_deliver_to": "https://client.example/webhook"
    }
  ]
}
```

## Security Considerations

### Isolation Requirements

- Test modes MUST be completely isolated from production systems
- No real platform API calls should be made in dry run mode
- Test data should never mix with production data
- Clear visual/API indicators must show test mode is active

### Authentication

- Same authentication requirements apply in test mode
- Rate limits should be enforced (potentially with higher limits)
- Audit logs should clearly mark test mode operations

### Data Privacy

- Test mode should not access real user data
- Synthetic data should be used for all simulations
- PII should never appear in test responses

## Best Practices

### Clear Mode Indication

Every response in test mode should clearly indicate its status:

```json
{
  "result": {...},
  "test_mode": {
    "dry_run": true,
    "simulated_time": "2025-01-06T09:00:00Z",
    "warning": "This is simulated data for testing only"
  }
}
```

### Deterministic Behavior

Given the same inputs and scenario, results should be reproducible:

```python
# Seed random generators
random.seed(hash(campaign_id + scenario))

# Use consistent time progressions
time_deltas = STANDARD_EVENT_TIMELINE[event_name]
```

### Realistic Constraints

Maintain platform constraints even in simulation:

- Minimum budgets still apply
- Targeting restrictions enforced
- Creative specifications validated
- Rate limits respected

## Use Cases

### 1. Development Testing

```python
def test_campaign_lifecycle():
    # Create campaign
    campaign = client.create_media_buy(
        budget=1000,
        headers={"X-Dry-Run": "true"}
    )
    
    # Jump through key events
    for event in ["campaign_started", "learning_phase_complete"]:
        result = client.get_delivery(
            campaign.id,
            headers={"X-Jump-To-Event": event}
        )
        assert result.status == expected_status[event]
```

### 2. CI/CD Pipeline

```yaml
test:
  script:
    - export ADCP_DRY_RUN=true
    - pytest tests/campaigns --adcp-scenario=success_campaign
    - pytest tests/errors --adcp-scenario=policy_violation
```

### 3. Interactive Demos

```python
# Sales demo showing full month in 5 minutes
demo = ADCPDemo(dry_run=True, auto_advance=True)
demo.create_campaign(budget=10000)
demo.show_timeline(compress_30_days_to_5_minutes=True)
```

### 4. Training Environment

```python
# Safe sandbox for new users
training_client = ADCPClient(
    dry_run=True,
    test_scenario="training_mode"
)
# All operations safe, no real costs
```

## Benefits

1. **Accelerated Development**: Test full lifecycles in seconds instead of weeks
2. **Comprehensive Testing**: Cover edge cases and error scenarios deterministically
3. **Cost Reduction**: No real advertising spend required for testing
4. **Risk Mitigation**: Test in isolation from production systems
5. **Better Demos**: Show complete workflows in real-time presentations
6. **Faster Onboarding**: Safe environment for learning the platform

## Migration Path

### Phase 1: Basic Dry Run (Required)
- Implement `X-Dry-Run` header support
- Return simulated responses for all operations
- No side effects on real platforms

### Phase 2: Time Simulation (Recommended)
- Add `X-Mock-Time` support
- Implement `X-Jump-To-Event` for key events
- Provide realistic metrics progression

### Phase 3: Advanced Scenarios (Optional)
- Support `X-Test-Scenario` for complex workflows
- Add `X-Auto-Advance` for timeline progression
- Implement webhook simulation

## Implementation Considerations

### Cost Tracking
Dry run mode tracks accumulated "would-be" costs for budget planning and forecasting.

### Scenario Flexibility
Test scenarios can be standardized across AdCP implementations, with room for platform-specific extensions.

### Time Boundaries
Time jumping is typically limited to reasonable campaign durations (e.g., 90 days forward) to maintain realistic simulations.

### Webhook Handling
Webhooks are queued and can be retrieved for inspection in dry run mode, but are not delivered to actual endpoints.

### Test Data
Implementations should provide standard test data sets (creatives, targeting, etc.) for consistency across platforms.

### Performance Modeling
Metric generation follows realistic performance curves based on industry standards, with platform-specific variations allowed.

### State Persistence
Test campaign state can persist across sessions based on implementation needs, with clear reset mechanisms available.

## Related Work

- [Stripe Test Mode](https://stripe.com/docs/testing) - Comprehensive test card numbers and scenarios
- [Google Ads API Test Accounts](https://developers.google.com/google-ads/api/docs/test-accounts) - Isolated test environment
- [AWS Time Injection](https://docs.aws.amazon.com/timestream/latest/developerguide/time-injection.html) - Time-series testing
- [Facebook Marketing API Sandbox](https://developers.facebook.com/docs/marketing-api/sandbox) - Ad account simulation

## Summary

Time simulation and dry run capabilities significantly improve the developer experience for AdCP implementations. By enabling rapid testing of full campaign lifecycles, comprehensive error scenario coverage, and safe experimentation, these features accelerate development and improve implementation quality.

The approach balances simplicity with power, allowing basic implementations to start with simple dry run mode while advanced implementations can provide sophisticated time simulation and scenario testing.