---
title: Optimization & Reporting
description: Monitor campaign performance, analyze delivery metrics, and optimize media buys using AdCP's reporting and optimization tools.
keywords: [campaign optimization, performance reporting, delivery analytics, media buy optimization, campaign monitoring]
---

# Optimization & Reporting

Continuous improvement through data-driven monitoring and optimization. AdCP provides comprehensive reporting tools and optimization features to help you track performance, analyze delivery, and improve campaign outcomes.

Reporting in AdCP leverages the same [Dimensions](../advanced-topics/dimensions.md) system used for targeting, enabling consistent analysis across the campaign lifecycle. This unified approach means you can report on exactly what you targeted.

Performance data feeds into AdCP's [Accountability & Trust Framework](../index.md#accountability--trust-framework), enabling publishers to build reputation through consistent delivery and helping buyers make data-driven allocation decisions.

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

Publishers can proactively push reporting data to buyers through webhook notifications or offline file delivery. This eliminates continuous polling and provides timely campaign insights.

### Delivery Methods

**1. Webhook Push (Real-time)** - HTTP POST to buyer endpoint
- Best for: Most buyer-seller relationships
- Latency: Near real-time (seconds to minutes)
- Cost: Standard webhook infrastructure

**2. Offline File Delivery (Batch)** - Cloud storage bucket push
- Best for: Large buyer-seller pairs (high volume)
- Latency: Scheduled batch delivery (hourly/daily)
- Cost: Significantly lower ($0.01-0.10 per GB vs. $0.50-2.00 per 1M webhooks)
- Format: JSON Lines, CSV, or Parquet files
- Storage: S3, GCS, Azure Blob Storage

**Example: Offline Delivery**
Publisher pushes daily report files to buyer's cloud storage:
```
s3://buyer-reports/publisher_name/2024/02/05/media_buy_delivery.json.gz
```

File contains same structure as webhook payload but aggregated across all campaigns. Buyer processes files on their schedule.

**When to Use Offline Delivery:**
- \>100 active campaigns with same buyer
- Hourly reporting requirements (24x cost reduction)
- High data volume (detailed breakdowns, dimensional data)
- Buyer has batch processing infrastructure

Publishers declare support for offline delivery in product capabilities:
```json
{
  "reporting_capabilities": {
    "supports_webhooks": true,
    "supports_offline_delivery": true,
    "offline_delivery_protocols": ["s3", "gcs"]
  }
}
```

### Webhook Configuration

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

Publishers declare supported reporting frequencies in the product's `reporting_capabilities`. Publishers are **not required** to support all frequencies - choose what makes operational sense for your platform.

- **`hourly`**: Receive notifications every hour during campaign flight (optional, consider cost/complexity)
- **`daily`**: Receive notifications once per day (most common, recommended for Phase 1)
- **`monthly`**: Receive notifications once per month (timezone specified by publisher)

**Cost Consideration:** Hourly webhooks generate 24x more traffic than daily. Large buyer-seller pairs may prefer offline reporting mechanisms (see below) for cost efficiency.

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

### Timezone Handling

**Recommendation: Use UTC for all reporting periods.** This eliminates DST complexity, simplifies reconciliation, and reduces implementation burden for both publishers and buyers.

#### UTC Reporting (Recommended)

```json
{
  "reporting_capabilities": {
    "timezone": "UTC",
    "available_reporting_frequencies": ["daily"]
  }
}
```

**Benefits:**
- No DST transitions (every day is 24 hours)
- Simpler period calculations
- Easier reconciliation across systems
- Industry standard for programmatic advertising

#### Local Timezone Reporting (If Required)

If business requirements demand local timezone reporting (e.g., for broadcast media aligned to market schedules):

- **Daily**: Reporting day starts/ends at midnight in publisher's timezone
- **Monthly**: Reporting month starts on 1st and ends on last day of month in publisher's timezone
- Use IANA timezone identifiers (e.g., `"America/New_York"`)
- Include timezone offset in all ISO 8601 timestamps

**Example**: Publisher with `"timezone": "America/New_York"` and daily frequency sends notifications at ~8:00 UTC (midnight ET + expected delay).

#### DST Transition Handling (Local Timezone Only)

**If using local timezone reporting** (not UTC), be aware that DST transitions create 23-hour or 25-hour reporting days.

**Key Considerations:**
- **Spring Forward**: Creates a 23-hour day (e.g., March 10 in America/New_York)
- **Fall Back**: Creates a 25-hour day (e.g., November 3 in America/New_York)
- Include `duration_hours` field in reporting_period to prevent billing disputes
- Pro-rate budgets based on actual duration, not assumed 24 hours
- Use timezone-aware libraries (moment-timezone, date-fns-tz) for period calculations

**Optional DST Fields in Webhook Payload:**
```json
{
  "reporting_period": {
    "start": "2024-03-10T00:00:00-05:00",
    "end": "2024-03-10T23:59:59-04:00",
    "duration_hours": 23,
    "is_dst_transition": true,
    "dst_transition_type": "spring_forward"
  }
}
```

These fields help buyers detect and handle non-24-hour days correctly. Omit if using UTC reporting.

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

#### Partial Failure Handling

When aggregating multiple media buys into a single webhook, publishers must handle cases where some campaigns have data available while others don't.

**Approach: Best-Effort Delivery with Status Indicators**

Publishers SHOULD send aggregated webhooks containing all available data, using status fields to indicate partial availability:

```json
{
  "notification_type": "scheduled",
  "sequence_number": 5,
  "reporting_period": {
    "start": "2024-02-05T00:00:00Z",
    "end": "2024-02-05T23:59:59Z"
  },
  "currency": "USD",
  "media_buy_deliveries": [
    {
      "media_buy_id": "mb_001",
      "status": "active",
      "totals": {
        "impressions": 50000,
        "spend": 1750
      }
    },
    {
      "media_buy_id": "mb_002",
      "status": "active",
      "totals": {
        "impressions": 48500,
        "spend": 1695
      }
    },
    {
      "media_buy_id": "mb_003",
      "status": "reporting_delayed",
      "message": "Reporting data temporarily unavailable for this campaign",
      "expected_availability": "2024-02-06T02:00:00Z"
    }
  ],
  "partial_data": true,
  "unavailable_count": 1
}
```

**Key Fields for Partial Failures:**
- `partial_data`: Boolean indicating if any campaigns are missing data
- `unavailable_count`: Number of campaigns with delayed/missing data
- `status`: Per-campaign status (`"active"`, `"reporting_delayed"`, `"failed"`)
- `expected_availability`: When delayed data is expected (if known)

**When to Use Partial Delivery:**
1. **Upstream delays**: Some data sources are slower than others
2. **System degradation**: Partial system outage affects subset of campaigns
3. **Data quality issues**: Specific campaigns fail validation, others proceed
4. **Rate limiting**: API limits prevent fetching all campaign data

**When NOT to Use Partial Delivery:**
1. **Complete system outage**: Send `"delayed"` notification instead
2. **All campaigns affected**: Use `notification_type: "delayed"`
3. **Buyer endpoint issues**: Circuit breaker handles this (don't send at all)

**Buyer Processing Logic:**
```javascript
function processAggregatedWebhook(webhook) {
  if (webhook.partial_data) {
    console.warn(`Partial data: ${webhook.unavailable_count} campaigns delayed`);
  }

  for (const delivery of webhook.media_buy_deliveries) {
    if (delivery.status === 'reporting_delayed') {
      // Mark campaign as pending, retry via polling or wait for next webhook
      markCampaignPending(delivery.media_buy_id, delivery.expected_availability);
    } else if (delivery.status === 'active') {
      // Process normal delivery data
      processCampaignMetrics(delivery);
    } else {
      console.error(`Unexpected status for ${delivery.media_buy_id}: ${delivery.status}`);
    }
  }
}
```

**Best Practices:**
- Always include all campaigns in array, even if data unavailable (with status indicator)
- Set `partial_data: true` flag when any campaigns are delayed/failed
- Provide `expected_availability` timestamp if known
- Don't retry the entire webhook - buyers can poll individual campaigns if needed
- Track partial delivery rates in monitoring to detect systemic issues

### Privacy and Compliance

#### PII Scrubbing for GDPR/CCPA

Publishers MUST scrub personally identifiable information (PII) from all webhook payloads to ensure GDPR and CCPA compliance. Reporting webhooks should contain only aggregated, anonymized metrics.

**What to Scrub:**
- User IDs, device IDs, IP addresses
- Email addresses, phone numbers
- Precise geolocation data (latitude/longitude)
- Cookie IDs, advertising IDs (unless aggregated)
- Any custom dimensions containing PII

**What to Keep:**
- Aggregated metrics (impressions, spend, clicks, etc.)
- Coarse geography (city, state, country - not street address)
- Device type categories (mobile, desktop, tablet)
- Browser/OS categories
- Time-based aggregations

**Example - Before PII Scrubbing (❌ DO NOT SEND):**
```json
{
  "media_buy_id": "mb_001",
  "user_events": [
    {
      "user_id": "user_12345",
      "ip_address": "192.168.1.100",
      "device_id": "abc-def-ghi",
      "impressions": 1,
      "lat": 40.7128,
      "lon": -74.0060
    }
  ]
}
```

**Example - After PII Scrubbing (✅ CORRECT):**
```json
{
  "media_buy_id": "mb_001",
  "totals": {
    "impressions": 125000,
    "spend": 5625.00,
    "clicks": 250
  },
  "by_geography": [
    {
      "city": "New York",
      "state": "NY",
      "country": "US",
      "impressions": 45000,
      "spend": 2025.00
    }
  ]
}
```

**Publisher Responsibilities:**
- Implement PII scrubbing at the data collection layer, not at webhook delivery
- Ensure aggregation thresholds prevent re-identification (e.g., minimum 10 users per segment)
- Document what data is collected vs. what is shared in webhooks
- Provide data processing agreements (DPAs) for GDPR compliance
- Support GDPR/CCPA data deletion requests

**Buyer Responsibilities:**
- Do not request PII in `requested_metrics` or custom dimensions
- Understand that webhook data is aggregated and anonymized
- Implement proper data retention policies
- Include webhook data in privacy policies and user disclosures

### Implementation Best Practices

1. **Handle Arrays**: Always process `media_buy_deliveries` as an array, even if it contains one element
2. **Idempotent Handlers**: Process duplicate notifications safely (webhooks use at-least-once delivery)
3. **Sequence Tracking**: Use `sequence_number` to detect missing or out-of-order notifications
4. **Fallback Polling**: Continue periodic polling as backup if webhooks fail
5. **Timezone Awareness**: Store publisher's reporting timezone for accurate period calculation
6. **Validate Frequency**: Ensure requested frequency is in product's `available_reporting_frequencies`
7. **Validate Metrics**: Ensure requested metrics are in product's `available_metrics`
8. **PII Compliance**: Never include user-level data in webhook payloads

### Webhook Health Monitoring

Publishers SHOULD provide operational visibility into webhook delivery health to help buyers diagnose issues and monitor reliability.

#### Health Check via get_media_buy_delivery

The existing `get_media_buy_delivery` task returns webhook health metadata when a webhook is configured:

```json
{
  "status": "completed",
  "message": "Delivery report for campaign campaign_2024",
  "data": {
    "media_buy_id": "mb_001",
    "totals": { ... },
    "webhook_health": {
      "webhook_url": "https://buyer.example.com/webhooks/reporting",
      "last_delivery_attempt": "2024-02-05T08:00:15Z",
      "last_successful_delivery": "2024-02-05T08:00:15Z",
      "last_failure": "2024-02-04T08:00:10Z",
      "last_failure_reason": "Connection timeout after 10 seconds",
      "total_attempts": 42,
      "total_successes": 40,
      "total_failures": 2,
      "circuit_breaker_status": "CLOSED",
      "next_scheduled_delivery": "2024-02-06T08:00:00Z"
    }
  }
}
```

**Key Health Fields:**
- `last_delivery_attempt`: When publisher last attempted delivery (any result)
- `last_successful_delivery`: Most recent successful delivery
- `last_failure`: Most recent failed delivery attempt
- `last_failure_reason`: Human-readable error from last failure
- `total_attempts`: Lifetime webhook delivery attempts
- `total_successes`: Lifetime successful deliveries
- `total_failures`: Lifetime failed deliveries
- `circuit_breaker_status`: Current circuit breaker state (`CLOSED`, `OPEN`, `HALF_OPEN`)
- `next_scheduled_delivery`: When next webhook is scheduled

**Buyer Use Cases:**
1. **Debugging**: "Why am I not receiving webhooks?" → Check `circuit_breaker_status` and `last_failure_reason`
2. **Reliability**: Calculate success rate from `total_successes / total_attempts`
3. **Alerting**: Monitor `last_successful_delivery` to detect prolonged failures
4. **Validation**: Compare `next_scheduled_delivery` to expected frequency

#### Monitoring Best Practices

**For Publishers:**
- Include webhook health in every `get_media_buy_delivery` response when webhook configured
- Persist delivery attempt history (last 30 days minimum)
- Emit metrics on webhook delivery rates, latencies, and circuit breaker events
- Alert internal teams when circuit breakers open for high-value buyers
- Provide webhook delivery logs to buyers upon request (via support channels)

**For Buyers:**
- Poll `get_media_buy_delivery` occasionally to check webhook health
- Alert when `circuit_breaker_status` is `OPEN` (indicates endpoint issues)
- Track `last_successful_delivery` timestamp to detect missed webhooks
- Calculate rolling success rates to monitor publisher reliability
- Implement fallback to polling when webhook health degrades

**Example Monitoring Query:**
```javascript
async function checkWebhookHealth(mediaBuyId) {
  const delivery = await adcp.getMediaBuyDelivery({ media_buy_id: mediaBuyId });
  const health = delivery.data.webhook_health;

  if (!health) {
    return { status: 'no_webhook_configured' };
  }

  if (health.circuit_breaker_status === 'OPEN') {
    return {
      status: 'webhook_failing',
      message: `Circuit breaker OPEN. Last failure: ${health.last_failure_reason}`,
      action: 'Check buyer endpoint availability and logs'
    };
  }

  const timeSinceSuccess = Date.now() - new Date(health.last_successful_delivery).getTime();
  const hoursSinceSuccess = timeSinceSuccess / (1000 * 60 * 60);

  if (hoursSinceSuccess > 48) {
    return {
      status: 'webhook_stale',
      message: `No successful delivery in ${hoursSinceSuccess.toFixed(1)} hours`,
      action: 'Verify webhook endpoint is reachable'
    };
  }

  const successRate = health.total_successes / health.total_attempts;
  if (successRate < 0.95) {
    return {
      status: 'webhook_degraded',
      message: `Success rate: ${(successRate * 100).toFixed(1)}%`,
      action: 'Investigate intermittent failures'
    };
  }

  return { status: 'healthy', success_rate: successRate };
}
```

## Data Reconciliation

**The `get_media_buy_delivery` API is the authoritative source of truth for all campaign metrics**, regardless of whether you use webhooks, offline delivery, or polling.

Reconciliation is important for **any reporting delivery method** because:
- **Webhooks**: May be missed due to network failures or circuit breaker drops
- **Offline files**: May be delayed, corrupted, or fail to process
- **Polling**: May miss data during API outages
- **Late-arriving data**: Impressions can arrive 24-48+ hours after initial reporting (all methods)

### Reconciliation Process

Buyers SHOULD periodically reconcile delivered data against API to ensure accuracy:

**Recommended Reconciliation Schedule:**
- **Hourly delivery**: Reconcile via API daily
- **Daily delivery**: Reconcile via API weekly
- **Monthly delivery**: Reconcile via API at month end + 7 days
- **Campaign close**: Always reconcile after campaign_end + attribution_window

**Reconciliation Logic:**
```javascript
async function reconcileWebhookData(mediaBuyId, startDate, endDate) {
  // Get authoritative data from API
  const apiData = await adcp.getMediaBuyDelivery({
    media_buy_id: mediaBuyId,
    date_range: { start: startDate, end: endDate }
  });

  // Compare with webhook data in local database
  const webhookData = await db.getWebhookTotals(mediaBuyId, startDate, endDate);

  const discrepancy = {
    impressions: apiData.totals.impressions - webhookData.impressions,
    spend: apiData.totals.spend - webhookData.spend,
    clicks: apiData.totals.clicks - webhookData.clicks
  };

  // Acceptable discrepancy thresholds
  const impressionVariance = Math.abs(discrepancy.impressions) / apiData.totals.impressions;
  const spendVariance = Math.abs(discrepancy.spend) / apiData.totals.spend;

  if (impressionVariance > 0.02 || spendVariance > 0.01) {
    // Significant discrepancy (>2% impressions or >1% spend)
    console.warn(`Reconciliation discrepancy for ${mediaBuyId}:`, discrepancy);

    // Update local database with authoritative API data
    await db.updateCampaignTotals(mediaBuyId, apiData.totals);

    // Alert if discrepancy is unusually large
    if (impressionVariance > 0.10 || spendVariance > 0.05) {
      await alertOps(`Large reconciliation discrepancy detected`, {
        media_buy_id: mediaBuyId,
        webhook_totals: webhookData,
        api_totals: apiData.totals,
        discrepancy
      });
    }
  }

  return {
    status: impressionVariance < 0.02 ? 'reconciled' : 'discrepancy_found',
    api_data: apiData.totals,
    webhook_data: webhookData,
    discrepancy
  };
}
```

**Why Discrepancies Occur:**
1. **Delivery failures**: Webhooks missed, offline files corrupted, API timeouts during polling
2. **Late-arriving data**: Impressions attributed after initial reporting (all delivery methods)
3. **Data corrections**: Publisher adjusts metrics after initial reporting
4. **Processing errors**: Buyer-side failures to process delivered data
5. **Timezone differences**: Period boundaries may differ between delivery and API query

**Source of Truth Rules:**
- **For billing**: Always use `get_media_buy_delivery` API at campaign end + attribution window
- **For real-time decisions**: Use delivered data (webhook/file/poll) for speed, reconcile later
- **For discrepancies**: API data wins, update local records accordingly
- **For audits**: API provides complete historical data, delivered data is ephemeral

**Best Practices:**
- Store webhook `sequence_number` to detect missed notifications
- Run automated reconciliation daily for active campaigns
- Alert on discrepancies >2% for impressions or >1% for spend
- Use API data for all financial reporting and invoicing
- Document reconciliation process for audit compliance

### Late-Arriving Impressions

Ad serving data often arrives with significant delays due to attribution windows, offline tracking, and data pipeline latency. Publishers must handle late-arriving impressions transparently **regardless of delivery method** (webhooks, offline files, or polling).

#### Expected Delay Windows

Publishers declare `expected_delay_minutes` in product's `reporting_capabilities`:
- **Display/Video**: Typically 240-360 minutes (4-6 hours)
- **Audio**: Typically 480-720 minutes (8-12 hours)
- **CTV**: May be 1440+ minutes (24+ hours)

This represents when **most** data is available, not **all** data.

#### Late Arrival Handling

**Scenario**: Campaign runs Feb 1-7. Daily webhook sent Feb 2 at 8am with Feb 1 data. On Feb 3, publisher discovers 1000 additional Feb 1 impressions due to delayed attribution.

**Webhook Advantage:** Publisher can send a correction webhook with `notification_type: "correction"` to overwrite the previous period. With polling-only, buyer must detect discrepancy through reconciliation.

**Publisher Options:**

**Option 1: Next-Period Correction (Recommended)**
Include correction in next scheduled delivery (webhook, file, or available via API):
```json
{
  "notification_type": "scheduled",
  "sequence_number": 3,
  "reporting_period": {
    "start": "2024-02-02T00:00:00Z",
    "end": "2024-02-02T23:59:59Z"
  },
  "media_buy_deliveries": [{
    "media_buy_id": "mb_001",
    "totals": {
      "impressions": 52000,  // Feb 2 delivery
      "spend": 1820
    },
    "adjustments": [{
      "period": "2024-02-01",
      "impressions": 1000,
      "spend": 35,
      "reason": "Late-arriving impressions from attribution window"
    }]
  }]
}
```

**Option 2: Out-of-Band Correction (Webhooks Only)**
Send immediate corrective webhook with "overwrite this period" instruction (only for significant adjustments >5%):
```json
{
  "notification_type": "correction",
  "sequence_number": null,  // Not part of regular sequence
  "reporting_period": {
    "start": "2024-02-01T00:00:00Z",
    "end": "2024-02-01T23:59:59Z"
  },
  "media_buy_deliveries": [{
    "media_buy_id": "mb_001",
    "totals": {
      "impressions": 51000,  // UPDATED total for Feb 1
      "spend": 1785
    },
    "is_correction": true,
    "correction_reason": "Late-arriving impressions from attribution window"
  }]
}
```

**Buyer Processing:**
```javascript
function processWebhook(webhook) {
  if (webhook.notification_type === 'correction') {
    // Replace previous period data entirely
    db.replaceCampaignPeriod(
      webhook.media_buy_deliveries[0].media_buy_id,
      webhook.reporting_period.start,
      webhook.media_buy_deliveries[0].totals
    );
    console.log('Applied correction webhook');
  } else if (webhook.media_buy_deliveries[0].adjustments) {
    // Apply incremental adjustments
    for (const adjustment of webhook.media_buy_deliveries[0].adjustments) {
      db.incrementCampaignPeriod(
        webhook.media_buy_deliveries[0].media_buy_id,
        adjustment.period,
        adjustment
      );
    }
    console.log('Applied period adjustments');
  }

  // Process current period data normally
  processCampaignMetrics(webhook.media_buy_deliveries[0]);
}
```

**Attribution Window Guidance:**
- **Post-click attribution**: 7-30 days typical
- **Post-view attribution**: 1-7 days typical
- **Offline conversions**: Can be 30-90 days
- **CTV attribution**: Can be 48+ hours for set-top box data

**Best Practices:**
- Document attribution windows in product descriptions
- Set `expected_delay_minutes` to cover 95th percentile, not median
- Send correction webhooks only for significant adjustments (>5% change)
- Use `adjustments` array for minor late-arriving data
- Include `is_correction` flag when replacing entire period data
- Run final reconciliation at campaign_end + max_attribution_window
- Clearly communicate attribution windows in publisher-buyer agreements

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