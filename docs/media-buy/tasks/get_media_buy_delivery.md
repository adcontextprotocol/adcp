---
title: get_media_buy_delivery
sidebar_position: 6
---

# get_media_buy_delivery

Retrieve comprehensive delivery metrics and performance data for reporting.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `context_id` | string | Yes | Context identifier for session persistence |
| `media_buy_id` | string | Yes | ID of the media buy to get delivery data for |
| `start_date` | string | No | Start date for reporting period (YYYY-MM-DD) |
| `end_date` | string | No | End date for reporting period (YYYY-MM-DD) |

## Response Format

```json
{
  "context_id": "string",
  "media_buy_id": "string",
  "status": "string",
  "reporting_period": {
    "start": "string",
    "end": "string"
  },
  "currency": "string",
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
```

### Field Descriptions

- **context_id**: Context identifier for session persistence
- **media_buy_id**: The media buy ID from the request
- **status**: Current media buy status (`pending_activation`, `active`, `paused`, `completed`, `failed`)
- **reporting_period**: Date range for the report
  - **start**: ISO 8601 start timestamp
  - **end**: ISO 8601 end timestamp
- **currency**: Currency code (typically `"USD"`)
- **totals**: Aggregate metrics across all packages
  - **impressions**: Total impressions delivered
  - **spend**: Total amount spent
  - **clicks**: Total clicks (if applicable)
  - **ctr**: Click-through rate (clicks/impressions)
  - **video_completions**: Total video completions (if applicable)
  - **completion_rate**: Video completion rate (completions/impressions)
- **by_package**: Metrics broken down by package
  - **package_id**: Package identifier
  - **impressions**: Package impressions
  - **spend**: Package spend
  - **clicks**: Package clicks
  - **video_completions**: Package video completions
  - **pacing_index**: Delivery pace (1.0 = on track, &lt;1.0 = behind, &gt;1.0 = ahead)
- **daily_breakdown**: Day-by-day delivery
  - **date**: Date (YYYY-MM-DD)
  - **impressions**: Daily impressions
  - **spend**: Daily spend

## Example

### Request
```json
{
  "context_id": "ctx-media-buy-abc123",  // From previous operations
  "media_buy_id": "gam_1234567890",
  "start_date": "2024-02-01",
  "end_date": "2024-02-07"
}
```

### Response
```json
{
  "context_id": "ctx-media-buy-abc123",  // Server maintains context
  "media_buy_id": "gam_1234567890",
  "status": "active",
  "reporting_period": {
    "start": "2024-02-01T00:00:00Z",
    "end": "2024-02-07T23:59:59Z"
  },
  "currency": "USD",
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
```

## Metrics Definitions

- **Impressions**: Number of times ads were displayed
- **Spend**: Amount spent in the specified currency
- **Clicks**: Number of times users clicked on ads
- **CTR (Click-Through Rate)**: Clicks divided by impressions
- **Video Completions**: Number of video ads watched to completion
- **Completion Rate**: Video completions divided by video impressions
- **Pacing Index**: Actual delivery rate vs. expected delivery rate

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