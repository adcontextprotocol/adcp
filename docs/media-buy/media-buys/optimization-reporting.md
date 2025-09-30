---
title: Optimization & Reporting
description: Monitor campaign performance, analyze delivery metrics, and optimize media buys using AdCP's reporting and optimization tools.
keywords: [campaign optimization, performance reporting, delivery analytics, media buy optimization, campaign monitoring]
---

# Optimization & Reporting

Continuous improvement through data-driven monitoring and optimization. AdCP provides comprehensive reporting tools and optimization features to help you track performance, analyze delivery, and improve campaign outcomes.

Reporting in AdCP leverages the same [Dimensions](../advanced-topics/dimensions.md) system used for targeting, enabling consistent analysis across the campaign lifecycle. This unified approach means you can report on exactly what you targeted.

## Key Optimization Tasks

### Delivery Reporting
Use [`get_media_buy_delivery`](../task-reference/get_media_buy_delivery) to retrieve comprehensive performance data including impressions, spend, clicks, and conversions across all campaign packages.

Alternatively, configure **webhook-based reporting** during media buy creation to receive automated delivery notifications at regular intervals.

### Campaign Updates
Use [`update_media_buy`](../task-reference/update_media_buy) to modify campaign settings, budgets, and configurations based on performance insights.

## Optimization Workflow

The typical optimization cycle follows this pattern:

1. **Monitor Delivery**: Track campaign performance against targets
2. **Analyze Performance**: Identify optimization opportunities  
3. **Make Adjustments**: Update budgets, targeting, or creative assignments
4. **Track Changes**: Monitor impact of optimizations
5. **Iterate**: Continuous improvement through regular analysis

## Performance Monitoring

### Real-Time Metrics
Track campaign delivery as it happens:
- **Impression delivery** vs. targets
- **Spend pacing** against budget
- **Click-through rates** and engagement
- **Conversion tracking** for business outcomes

### Historical Analysis
Understand performance trends over time:
- **Daily/hourly breakdowns** of key metrics
- **Performance comparisons** across time periods
- **Trend identification** for optimization opportunities

### Alerting and Notifications
Stay informed of important campaign events:
- **Delivery alerts** for pacing issues
- **Performance notifications** for significant changes
- **Budget warnings** before limits are reached

## Webhook-Based Reporting

Publishers can proactively push reporting data to buyers on a scheduled basis through webhook notifications. This eliminates the need for continuous polling and provides timely campaign insights.

### Configuration

Configure reporting webhooks when creating a media buy using the `reporting_webhook` parameter:

```json
{
  "buyer_ref": "campaign_2024",
  "packages": [...],
  "reporting_webhook": {
    "url": "https://buyer.example.com/webhooks/reporting",
    "auth_type": "bearer",
    "auth_token": "secret_token",
    "reporting_frequency": "daily"
  }
}
```

### Supported Frequencies

Publishers declare supported reporting frequencies in the product's `reporting_capabilities`:

- **`hourly`**: Receive notifications every hour during campaign flight
- **`daily`**: Receive notifications once per day (timezone specified by publisher)
- **`monthly`**: Receive notifications once per month (timezone specified by publisher)

### Available Metrics

Publishers declare which metrics they can provide in `reporting_capabilities.available_metrics`. Common metrics include:

- **`impressions`**: Ad views (always available)
- **`spend`**: Amount spent (always available)
- **`clicks`**: Click events
- **`ctr`**: Click-through rate
- **`video_completions`**: Completed video views
- **`completion_rate`**: Video completion percentage
- **`conversions`**: Post-click or post-view conversions
- **`viewability`**: Viewable impression percentage
- **`engagement_rate`**: Platform-specific engagement metric

Buyers can optionally request a subset via `requested_metrics` to reduce payload size and focus on relevant KPIs.

### Publisher Commitment

When a reporting webhook is configured, publishers commit to sending:

**(campaign_duration / reporting_frequency) + 1** notifications

- One notification per frequency period during the campaign
- One final notification when the campaign completes
- If reporting data is delayed beyond the expected delay window, a `"delayed"` notification will be sent

### Webhook Payload

Reporting webhooks use the same payload structure as [`get_media_buy_delivery`](../task-reference/get_media_buy_delivery) with additional metadata:

```json
{
  "notification_type": "scheduled",
  "sequence_number": 5,
  "next_expected_at": "2024-02-06T08:00:00Z",
  "reporting_period": {
    "start": "2024-02-05T00:00:00Z",
    "end": "2024-02-05T23:59:59Z"
  },
  "currency": "USD",
  "media_buy_deliveries": [
    {
      "media_buy_id": "mb_001",
      "buyer_ref": "campaign_a",
      "status": "active",
      "totals": {
        "impressions": 125000,
        "spend": 5625.00,
        "clicks": 250,
        "ctr": 0.002
      },
      "by_package": [...]
    }
  ]
}
```

**Fields:**
- **`notification_type`**: `"scheduled"` (regular update), `"final"` (campaign complete), or `"delayed"` (data not yet available)
- **`sequence_number`**: Sequential notification number (starts at 1)
- **`next_expected_at`**: ISO 8601 timestamp for next notification (omitted for final notifications)
- **`media_buy_deliveries`**: Array of media buy delivery data (may contain multiple media buys aggregated by publisher)

### Timezone Considerations

For daily and monthly frequencies, the publisher's reporting timezone (from `reporting_capabilities.timezone`) determines period boundaries:

- **Daily**: Reporting day starts/ends at midnight in publisher's timezone
- **Monthly**: Reporting month starts on 1st and ends on last day of month in publisher's timezone
- **Hourly**: Uses UTC unless otherwise specified

**Example**: Publisher with `"timezone": "America/New_York"` and daily frequency sends notifications at ~8:00 UTC (midnight ET + expected delay).

### Delayed Reporting

If reporting data is not available within the product's `expected_delay_minutes`, publishers send a notification with `notification_type: "delayed"`:

```json
{
  "notification_type": "delayed",
  "sequence_number": 3,
  "next_expected_at": "2024-02-06T10:00:00Z",
  "message": "Reporting data delayed due to upstream processing. Expected availability in 2 hours."
}
```

This prevents buyers from incorrectly assuming a missed notification.

### Webhook Aggregation

Publishers SHOULD aggregate webhooks to reduce call volume when multiple media buys share:
- Same webhook URL
- Same reporting frequency
- Same reporting period

**Example**: Buyer has 100 active campaigns with daily reporting to the same endpoint. Publisher sends:
- **Without aggregation**: 100 webhooks per day (inefficient)
- **With aggregation**: 1 webhook per day containing all 100 campaigns (optimal)

The `media_buy_deliveries` array may contain 1 to N media buys per webhook. Buyers should iterate through the array to process each campaign's data.

**Aggregated webhook example:**
```json
{
  "notification_type": "scheduled",
  "reporting_period": {
    "start": "2024-02-05T00:00:00Z",
    "end": "2024-02-05T23:59:59Z"
  },
  "currency": "USD",
  "media_buy_deliveries": [
    { "media_buy_id": "mb_001", "totals": { "impressions": 50000, "spend": 1750 }, ... },
    { "media_buy_id": "mb_002", "totals": { "impressions": 48500, "spend": 1695 }, ... },
    // ... 98 more media buys
  ]
}
```

Buyers should iterate through the array and process each media buy independently. If aggregated totals are needed, calculate them from the individual media buy totals.

### Implementation Best Practices

1. **Handle Arrays**: Always process `media_buy_deliveries` as an array, even if it contains one element
2. **Idempotent Handlers**: Process duplicate notifications safely (webhooks use at-least-once delivery)
3. **Sequence Tracking**: Use `sequence_number` to detect missing or out-of-order notifications
4. **Fallback Polling**: Continue periodic polling as backup if webhooks fail
5. **Timezone Awareness**: Store publisher's reporting timezone for accurate period calculation
6. **Validate Frequency**: Ensure requested frequency is in product's `available_reporting_frequencies`
7. **Validate Metrics**: Ensure requested metrics are in product's `available_metrics`

### Webhook Reliability

Reporting webhooks follow AdCP's standard webhook reliability patterns:

- **At-least-once delivery**: Same notification may be delivered multiple times
- **Best-effort ordering**: Notifications may arrive out of order
- **Timeout and retry**: Limited retry attempts on delivery failure

See [Core Concepts: Webhook Reliability](../../protocols/core-concepts.md#webhook-reliability) for detailed implementation guidance.

## Optimization Strategies

### Budget Optimization
- **Reallocation** between high and low performing packages
- **Pacing adjustments** for improved delivery
- **Spend efficiency** analysis and improvements

### Creative Optimization
- **Performance analysis** by creative asset
- **A/B testing** different creative approaches
- **Refresh strategies** to prevent creative fatigue

### Targeting Refinement
- **Audience performance** analysis
- **Geographic optimization** based on delivery data
- **Temporal adjustments** for optimal timing

## Performance Feedback Loop
The performance feedback system enables AI-driven optimization by feeding back business outcomes to publishers. See [`provide_performance_feedback`](../task-reference/provide_performance_feedback) for detailed API documentation.

### Performance Index Concept

A normalized score indicating relative performance:
- `0.0` = No measurable value or impact
- `1.0` = Baseline/expected performance
- `> 1.0` = Above average (e.g., 1.45 = 45% better)
- `< 1.0` = Below average (e.g., 0.8 = 20% worse)

### Sharing Performance Data

Buyers can voluntarily share performance outcomes using the [`provide_performance_feedback`](../task-reference/provide_performance_feedback) task:

```json
{
  "media_buy_id": "gam_1234567890",
  "measurement_period": {
    "start": "2024-01-15T00:00:00Z",
    "end": "2024-01-21T23:59:59Z"
  },
  "performance_index": 1.35,
  "metric_type": "conversion_rate"
}
```

### Supported Metrics

- **overall_performance**: General campaign success
- **conversion_rate**: Post-click or post-view conversions
- **brand_lift**: Brand awareness or consideration lift
- **click_through_rate**: Engagement with creative
- **completion_rate**: Video or audio completion rates
- **viewability**: Viewable impression rate
- **brand_safety**: Brand safety compliance
- **cost_efficiency**: Cost per desired outcome

### How Publishers Use Performance Data

Publishers can leverage performance indices to:

1. **Optimize Delivery**: Shift impressions to high-performing segments
2. **Adjust Pricing**: Update CPMs based on proven value
3. **Improve Products**: Refine product definitions based on performance patterns
4. **Enhance Algorithms**: Train ML models on actual business outcomes

### Privacy and Data Sharing

- Performance feedback sharing is voluntary and controlled by the buyer
- Aggregate performance patterns may be used to improve overall platform performance
- Individual campaign details remain confidential to the buyer-publisher relationship

### Dimensional Performance (Future)

Future implementations may support dimensional performance feedback, allowing optimization at the intersection of multiple dimensions (e.g., "mobile users in NYC perform 80% above baseline").

## Dimensional Consistency
Reporting uses the same [Dimensions](../advanced-topics/dimensions) system as targeting, enabling:
- **Consistent analysis** across campaign lifecycle
- **Granular breakdowns** by any targeting dimension
- **Cross-campaign insights** for portfolio optimization

### Target → Measure → Optimize
The power of the unified dimension system creates a virtuous cycle:

1. **Target**: Define your audience using dimensions (e.g., "Mobile users in major metros")
2. **Measure**: Report on the same dimensions (Track performance by device type and geography)
3. **Optimize**: Feed performance back to improve delivery (Shift budget to high-performing segments)

## Standard Metrics

All platforms must support these core metrics:

- **impressions**: Number of ad views
- **spend**: Amount spent in currency
- **clicks**: Number of clicks (if applicable)
- **ctr**: Click-through rate (clicks/impressions)

Optional standard metrics:

- **conversions**: Post-click/view conversions
- **viewability**: Percentage of viewable impressions
- **completion_rate**: Video/audio completion percentage
- **engagement_rate**: Platform-specific engagement metric

## Platform-Specific Considerations

Different platforms offer varying reporting and optimization capabilities:

### Google Ad Manager
- Comprehensive dimensional reporting, real-time and historical data, advanced viewability metrics

### Kevel
- Real-time reporting API, custom metric support, flexible aggregation options

### Triton Digital
- Audio-specific metrics (completion rates, skip rates), station-level performance data, daypart analysis

## Advanced Analytics

### Cross-Campaign Analysis
- **Portfolio performance** across multiple campaigns
- **Audience overlap** and frequency management
- **Budget allocation** optimization across campaigns

### Predictive Insights
- **Performance forecasting** based on historical data
- **Optimization recommendations** from AI analysis
- **Trend prediction** for proactive adjustments

## Response Times

Optimization operations have predictable timing:
- **Delivery reports**: ~60 seconds (data aggregation)
- **Campaign updates**: Minutes to days (depending on changes)
- **Performance analysis**: ~1 second (cached metrics)

## Best Practices

1. **Report Frequently**: Regular reporting improves optimization opportunities
2. **Track Pacing**: Monitor delivery against targets to avoid under/over-delivery
3. **Analyze Patterns**: Look for performance trends across dimensions
4. **Consider Latency**: Some metrics may have attribution delays
5. **Normalize Metrics**: Use consistent baselines for performance comparison

## Integration with Media Buy Lifecycle

Optimization and reporting is the ongoing phase that runs throughout active campaigns:

- **Connects to Creation**: Use learnings to improve future campaign setup
- **Guides Updates**: Data-driven decisions for campaign modifications
- **Enables Scale**: Proven strategies can be applied to similar campaigns
- **Feeds AI**: Performance data improves automated optimization

## Related Documentation

- **[`get_media_buy_delivery`](../task-reference/get_media_buy_delivery)** - Retrieve delivery reports
- **[`update_media_buy`](../task-reference/update_media_buy)** - Modify campaigns based on performance
- **[Media Buy Lifecycle](./index.md)** - Complete campaign management workflow
- **[Dimensions](../advanced-topics/dimensions)** - Understanding the dimension system
- **[Targeting](../advanced-topics/targeting)** - How dimensions enable targeting