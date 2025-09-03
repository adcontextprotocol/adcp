---
title: get_media_buy_delivery
sidebar_position: 6
---

# get_media_buy_delivery

Retrieve comprehensive delivery metrics and performance data for reporting.


**Request Schema**: [`/schemas/v1/media-buy/get-media-buy-delivery-request.json`](/schemas/v1/media-buy/get-media-buy-delivery-request.json)  
**Response Schema**: [`/schemas/v1/media-buy/get-media-buy-delivery-response.json`](/schemas/v1/media-buy/get-media-buy-delivery-response.json)

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `media_buy_ids` | string[] | No* | Array of publisher media buy IDs to get delivery data for |
| `buyer_refs` | string[] | No* | Array of buyer reference IDs to get delivery data for |
| `status_filter` | string \| string[] | No | Filter by status. Can be a single status or array of statuses: `"active"`, `"pending"`, `"paused"`, `"completed"`, `"failed"`, `"all"`. Defaults to `["active"]` |
| `start_date` | string | No | Start date for reporting period (YYYY-MM-DD) |
| `end_date` | string | No | End date for reporting period (YYYY-MM-DD) |

*Either `media_buy_ids` or `buyer_refs` can be provided. If neither is provided, returns all media buys in the current session context.

## Response (Message)

The response includes a human-readable message that:
- Summarizes campaign performance and key insights
- Highlights pacing and completion rates
- Provides recommendations based on performance
- Explains any delivery issues or optimizations

The message is returned differently in each protocol:
- **MCP**: Returned as a `message` field in the JSON response
- **A2A**: Returned as a text part in the artifact

## Response (Payload)

```json
{
  "reporting_period": {
    "start": "string",
    "end": "string"
  },
  "currency": "string",
  "aggregated_totals": {
    "impressions": "number",
    "spend": "number",
    "clicks": "number",
    "video_completions": "number",
    "media_buy_count": "number"
  },
  "deliveries": [
    {
      "media_buy_id": "string",
      "buyer_ref": "string",
      "status": "string",
      "totals": {
        "impressions": "number",
        "spend": "number",
        "clicks": "number",
        "ctr": "number",
        "video_completions": "number",
        "completion_rate": "number"
      },
      "by_package": [
        {
          "package_id": "string",
          "buyer_ref": "string",
          "impressions": "number",
          "spend": "number",
          "clicks": "number",
          "video_completions": "number",
          "pacing_index": "number"
        }
      ],
      "daily_breakdown": [
        {
          "date": "string",
          "impressions": "number",
          "spend": "number"
        }
      ]
    }
  ]
}
```

### Field Descriptions

- **reporting_period**: Date range for the report
  - **start**: ISO 8601 start timestamp
  - **end**: ISO 8601 end timestamp
- **currency**: ISO 4217 currency code (e.g., `"USD"`, `"EUR"`, `"GBP"`)
- **aggregated_totals**: Combined metrics across all returned media buys
  - **impressions**: Total impressions delivered across all media buys
  - **spend**: Total amount spent across all media buys
  - **clicks**: Total clicks across all media buys (if applicable)
  - **video_completions**: Total video completions across all media buys (if applicable)
  - **media_buy_count**: Number of media buys included in the response
- **deliveries**: Array of delivery data for each media buy
  - **media_buy_id**: Publisher's media buy identifier
  - **buyer_ref**: Buyer's reference identifier for this media buy
  - **status**: Current media buy status (`pending`, `active`, `paused`, `completed`, `failed`)
  - **totals**: Aggregate metrics for this media buy across all packages
    - **impressions**: Total impressions delivered
    - **spend**: Total amount spent
    - **clicks**: Total clicks (if applicable)
    - **ctr**: Click-through rate (clicks/impressions)
    - **video_completions**: Total video completions (if applicable)
    - **completion_rate**: Video completion rate (completions/impressions)
  - **by_package**: Metrics broken down by package
    - **package_id**: Publisher's package identifier
    - **buyer_ref**: Buyer's reference identifier for this package
    - **impressions**: Package impressions
    - **spend**: Package spend
    - **clicks**: Package clicks
    - **video_completions**: Package video completions
    - **pacing_index**: Delivery pace (1.0 = on track, &lt;1.0 = behind, &gt;1.0 = ahead)
  - **daily_breakdown**: Day-by-day delivery
    - **date**: Date (YYYY-MM-DD)
    - **impressions**: Daily impressions
    - **spend**: Daily spend

## Protocol-Specific Examples

The AdCP payload is identical across protocols. Only the request/response wrapper differs.

### MCP Request
```json
{
  "tool": "get_media_buy_delivery",
  "arguments": {
    "buyer_refs": ["nike_q1_campaign_2024"],
    "start_date": "2024-01-01",
    "end_date": "2024-01-31"
  }
}
```

### MCP Response
```json
{
  "message": "Campaign is 65% delivered with strong performance. CTR of 2.3% exceeds benchmark.",
  "reporting_period": {
    "start": "2024-01-01T00:00:00Z",
    "end": "2024-01-31T23:59:59Z"
  },
  "currency": "USD",
  "aggregated_totals": {
    "impressions": 1250000,
    "spend": 32500,
    "clicks": 28750,
    "video_completions": 875000,
    "media_buy_count": 1
  },
  "deliveries": [
    {
      "media_buy_id": "mb_12345",
      "status": "active",
      "totals": {
        "impressions": 1250000,
        "spend": 32500,
        "clicks": 28750,
        "ctr": 2.3,
        "video_completions": 875000,
        "completion_rate": 70
      },
      "by_package": [
        {
          "package_id": "pkg_ctv_001",
          "impressions": 750000,
          "spend": 22500,
          "clicks": 0,
          "video_completions": 525000,
          "pacing_index": 0.95
        }
      ]
    }
  ]
}
```

### A2A Request

#### Natural Language Invocation
```javascript
await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "Show me the delivery metrics for media buy mb_12345 from January 1st through January 31st, 2024."
    }]
  }
});
```

#### Explicit Skill Invocation
```javascript
await a2a.send({
  message: {
    parts: [{
      kind: "data",
      data: {
        skill: "get_media_buy_delivery",
        parameters: {
          media_buy_ids: ["mb_12345"],
          start_date: "2024-01-01",
          end_date: "2024-01-31"
        }
      }
    }]
  }
});
```

### A2A Response
A2A returns results as artifacts:
```json
{
  "artifacts": [{
      "name": "delivery_report",
      "parts": [
        {
          "kind": "text",
          "text": "Campaign is 65% delivered with strong performance. CTR of 2.3% exceeds benchmark."
        },
        {
          "kind": "data",
          "data": {
            "reporting_period": {
              "start": "2024-01-01T00:00:00Z",
              "end": "2024-01-31T23:59:59Z"
            },
            "currency": "USD",
            "aggregated_totals": {
              "impressions": 1250000,
              "spend": 32500,
              "clicks": 28750,
              "video_completions": 875000,
              "media_buy_count": 1
            },
            "deliveries": [
              {
                "media_buy_id": "mb_12345",
                "status": "active",
                "totals": {
                  "impressions": 1250000,
                  "spend": 32500,
                  "clicks": 28750,
                  "ctr": 2.3,
                  "video_completions": 875000,
                  "completion_rate": 70
                },
                "by_package": [
                  {
                    "package_id": "pkg_ctv_001",
                    "impressions": 750000,
                    "spend": 22500,
                    "clicks": 0,
                    "video_completions": 525000,
                    "pacing_index": 0.95
                  }
                ]
              }
            ]
          }
        }
      ]
    }]
}
```

### Key Differences
- **MCP**: Direct tool call with arguments, returns flat JSON response
- **A2A**: Skill invocation with input, returns artifacts with text and data parts
- **Payload**: The `input` field in A2A contains the exact same structure as MCP's `arguments`

## Scenarios

### Example 1: Single Media Buy Query

#### Request
```json
{
  "context_id": "ctx-media-buy-abc123",  // From previous operations
  "media_buy_ids": ["gam_1234567890"],
  "start_date": "2024-02-01",
  "end_date": "2024-02-07"
}
```

#### Response - Strong Performance
**Message**: "Your campaign delivered 450,000 impressions this week with strong engagement. The 0.2% CTR exceeds industry benchmarks, and your video completion rate of 70% is excellent. You're currently pacing slightly behind (-9%) but should catch up with weekend delivery. Effective CPM is $37.50."

**Payload**:
```json
{
  "reporting_period": {
    "start": "2024-02-01T00:00:00Z",
    "end": "2024-02-07T23:59:59Z"
  },
  "currency": "USD",
  "aggregated_totals": {
    "impressions": 450000,
    "spend": 16875.00,
    "clicks": 900,
    "video_completions": 315000,
    "media_buy_count": 1
  },
  "deliveries": [
    {
      "media_buy_id": "gam_1234567890",
      "status": "active",
      "totals": {
        "impressions": 450000,
        "spend": 16875.00,
        "clicks": 900,
        "ctr": 0.002,
        "video_completions": 315000,
        "completion_rate": 0.70
      },
      "by_package": [
        {
          "package_id": "pkg_ctv_prime_ca_ny",
          "impressions": 250000,
          "spend": 11250.00,
          "clicks": 500,
          "video_completions": 175000,
          "pacing_index": 0.93
        },
        {
          "package_id": "pkg_audio_drive_ca_ny",
          "impressions": 200000,
          "spend": 5625.00,
          "clicks": 400,
          "pacing_index": 0.88
        }
      ],
      "daily_breakdown": [
        {
          "date": "2024-02-01",
          "impressions": 64285,
          "spend": 2410.71
        }
      ]
    }
  ]
}
```

### Example 2: Multiple Media Buys with Status Filter

#### Request - Single Status
```json
{
  "context_id": "ctx-media-buy-abc123",
  "status_filter": "active",  // Only return active media buys
  "start_date": "2024-02-01",
  "end_date": "2024-02-07"
}
```

#### Request - Multiple Statuses
```json
{
  "context_id": "ctx-media-buy-abc123",
  "status_filter": ["active", "paused"],  // Return both active and paused media buys
  "start_date": "2024-02-01",
  "end_date": "2024-02-07"
}
```

#### Response - Multiple Active Campaigns
```json
{
  "message": "Your 3 active campaigns delivered 875,000 total impressions this week. Campaign performance varies: GAM campaign shows strong 0.2% CTR while Meta campaign needs attention with 0.08% CTR. Overall spend of $32,500 with average CPM of $37.14.",
  "context_id": "ctx-media-buy-abc123",
  "reporting_period": {
    "start": "2024-02-01T00:00:00Z",
    "end": "2024-02-07T23:59:59Z"
  },
  "currency": "USD",
  "aggregated_totals": {
    "impressions": 875000,
    "spend": 32500.00,
    "clicks": 1400,
    "video_completions": 481250,
    "media_buy_count": 3
  },
  "deliveries": [
    {
      "media_buy_id": "gam_1234567890",
      "status": "active",
      "totals": {
        "impressions": 450000,
        "spend": 16875.00,
        "clicks": 900,
        "ctr": 0.002,
        "video_completions": 315000,
        "completion_rate": 0.70
      },
      "by_package": [
        {
          "package_id": "pkg_ctv_prime_ca_ny",
          "impressions": 250000,
          "spend": 11250.00,
          "clicks": 500,
          "video_completions": 175000,
          "pacing_index": 0.93
        }
      ],
      "daily_breakdown": []
    },
    {
      "media_buy_id": "meta_9876543210",
      "status": "active",
      "totals": {
        "impressions": 125000,
        "spend": 5625.00,
        "clicks": 100,
        "ctr": 0.0008,
        "video_completions": 56250,
        "completion_rate": 0.45
      },
      "by_package": [
        {
          "package_id": "pkg_social_feed",
          "impressions": 125000,
          "spend": 5625.00,
          "clicks": 100,
          "video_completions": 56250,
          "pacing_index": 0.75
        }
      ],
      "daily_breakdown": []
    },
    {
      "media_buy_id": "ttd_5555555555",
      "status": "active",
      "totals": {
        "impressions": 300000,
        "spend": 10000.00,
        "clicks": 400,
        "ctr": 0.00133,
        "video_completions": 110000,
        "completion_rate": 0.37
      },
      "by_package": [
        {
          "package_id": "pkg_open_exchange",
          "impressions": 300000,
          "spend": 10000.00,
          "clicks": 400,
          "video_completions": 110000,
          "pacing_index": 1.05
        }
      ],
      "daily_breakdown": []
    }
  ]
}
```

## Metrics Definitions

- **Impressions**: Number of times ads were displayed
- **Spend**: Amount spent in the specified currency
- **Clicks**: Number of times users clicked on ads
- **CTR (Click-Through Rate)**: Clicks divided by impressions
- **Video Completions**: Number of video ads watched to completion
- **Completion Rate**: Video completions divided by video impressions
- **Pacing Index**: Actual delivery rate vs. expected delivery rate

## Usage Notes

- If `media_buy_ids` is not provided, returns all media buys for the context
- Use the `status_filter` parameter to control which media buys are returned:
  - Can be a single status string or an array of statuses
  - Use `"all"` to return media buys of any status
  - Defaults to `["active"]` if not specified
- If date range is not specified, returns lifetime delivery data
- Daily breakdown may be truncated for long campaigns or multiple media buys to reduce response size
- Some metrics (clicks, completions) may not be available for all formats
- Reporting data typically has a 2-4 hour delay
- Currency is always specified to avoid ambiguity

### Aggregated Fields for Multi-Buy Queries

When querying multiple media buys, the response includes `aggregated_totals` with:
- **impressions**: Sum of all impressions across returned media buys
- **spend**: Total spend across all returned media buys  
- **clicks**: Total clicks (where available)
- **video_completions**: Total video completions (where available)
- **media_buy_count**: Number of media buys included in the response

These aggregated fields provide a quick overview of overall campaign performance, while the `deliveries` array contains detailed metrics for each individual media buy.

## Implementation Guide

### Generating Performance Messages

The `message` field should provide actionable insights:

```python
def generate_delivery_message(report):
    # Calculate key performance indicators
    cpm = (report.totals.spend / report.totals.impressions) * 1000
    avg_pacing = calculate_average_pacing(report.by_package)
    
    # Analyze performance
    performance_level = analyze_performance(report.totals.ctr, report.totals.completion_rate)
    pacing_status = "on track" if avg_pacing > 0.95 else f"{int((1-avg_pacing)*100)}% behind"
    
    # Generate insights
    insights = []
    if performance_level == "strong":
        insights.append(f"The {report.totals.ctr:.1%} CTR exceeds industry benchmarks")
        if report.totals.completion_rate:
            insights.append(f"your video completion rate of {report.totals.completion_rate:.0%} is excellent")
    else:
        insights.append(f"the {report.totals.ctr:.2%} CTR is below expectations")
        if report.totals.completion_rate < 0.5:
            insights.append("completion rate suggests creative fatigue")
    
    # Build message
    return f"Your campaign delivered {report.totals.impressions:,} impressions {get_time_period(report.reporting_period)} with {performance_level} engagement. {'. '.join(insights)}. You're currently pacing {pacing_status}. Effective CPM is ${cpm:.2f}."
```

## Platform-Specific Metrics

Different platforms return different metrics based on their capabilities:

- **Total impressions delivered**: Available on all platforms
- **Total spend**: Available on all platforms  
- **Clicks**: Available where click tracking is supported (display, video)
- **Video completions**: Available for video inventory on supporting platforms
- **Package-level breakdown**: Granular performance by package/flight

## Usage Notes

- If dates are not specified, returns lifetime delivery data
- Metrics availability depends on the media type and platform capabilities
- Video metrics (completions, completion rate) only appear for video campaigns
- The pacing index helps identify delivery issues (aim for 0.95-1.05)
- Daily breakdown may be truncated for long date ranges
- Use this data for regular reporting and optimization decisions