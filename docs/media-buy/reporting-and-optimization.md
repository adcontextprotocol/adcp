---
title: Reporting & Optimization
---

# Reporting & Optimization

Reporting in AdCP:Buy leverages the same [Dimensions](dimensions.md) system used for targeting, enabling consistent analysis across the campaign lifecycle. This unified approach means you can report on exactly what you targeted.

## Delivery Reporting

The delivery reporting system provides real-time and historical performance data, aggregated by dimensions.

### Basic Delivery Status

The `get_media_buy_delivery` tool provides campaign-level metrics:

**Request**:
```json
{
  "media_buy_id": "gam_12345",
  "date_range": {
    "start_date": "2024-01-01",
    "end_date": "2024-01-07"
  }
}
```

**Response**:
```json
{
  "media_buy_id": "gam_12345",
  "status": "active",
  "totals": {
    "impressions": 1250000,
    "spend": 25000.00,
    "clicks": 3750,
    "conversions": 125
  },
  "pacing": {
    "daily_target": 100000,
    "daily_actual": 89286,
    "status": "slightly_behind"
  },
  "by_package": [
    {
      "package_id": "pkg_video_sports",
      "impressions": 750000,
      "spend": 18750.00
    }
  ]
}
```

### Dimensional Reporting (Future)

Rich reporting breaks down metrics by any combination of dimensions:

**Request**:
```json
{
  "media_buy_id": "gam_12345",
  "date_range": {
    "start_date": "2024-01-01",
    "end_date": "2024-01-07"
  },
  "dimensions": ["date", "geo_metro", "device_type"],
  "metrics": ["impressions", "spend", "ctr", "viewability"],
  "filters": {
    "geo_country_any_of": ["US"]
  }
}
```

**Response**:
```json
{
  "rows": [
    {
      "dimensions": {
        "date": "2024-01-01",
        "geo_metro": "501",  // NYC
        "device_type": "mobile"
      },
      "metrics": {
        "impressions": 125000,
        "spend": 3125.00,
        "ctr": 0.0032,
        "viewability": 0.78
      }
    },
    {
      "dimensions": {
        "date": "2024-01-01",
        "geo_metro": "501",
        "device_type": "desktop"
      },
      "metrics": {
        "impressions": 87500,
        "spend": 2625.00,
        "ctr": 0.0028,
        "viewability": 0.92
      }
    }
  ],
  "totals": {
    "impressions": 1250000,
    "spend": 25000.00,
    "ctr": 0.0030,
    "viewability": 0.85
  }
}
```

## Performance Feedback Loop

The performance index system enables AI-driven optimization by feeding back business outcomes.

### Update Performance Index

Clients provide normalized performance scores for each package:

**Request**:
```json
{
  "media_buy_id": "gam_12345",
  "package_performance": [
    {
      "package_id": "pkg_video_sports",
      "performance_index": 1.45,  // 45% above baseline
      "confidence_score": 0.92,
      "dimensional_performance": {
        "geo_metro": {
          "501": 1.8,   // NYC performing 80% above baseline
          "803": 1.2    // LA performing 20% above baseline
        },
        "device_type": {
          "mobile": 1.6,
          "desktop": 1.3
        }
      }
    }
  ]
}
```

### How Publishers Use Performance Data

Publishers can leverage performance indices to:

1. **Optimize Delivery**: Shift impressions to high-performing dimensions
2. **Adjust Pricing**: Update CPMs based on proven value
3. **Improve Products**: Refine product definitions based on performance patterns
4. **Enhance Algorithms**: Train ML models on actual business outcomes

## Reporting Consistency

The power of the unified dimension system:

### Target → Measure → Optimize

1. **Target**: "I want to reach mobile users in NYC"
   ```json
   {
     "geo_metro_any_of": ["501"],
     "device_type_any_of": ["mobile"]
   }
   ```

2. **Measure**: "How did mobile users in NYC perform?"
   ```json
   {
     "dimensions": ["geo_metro", "device_type"],
     "filters": {
       "geo_metro_any_of": ["501"],
       "device_type_any_of": ["mobile"]
     }
   }
   ```

3. **Optimize**: "Mobile users in NYC over-performed by 80%"
   ```json
   {
     "dimensional_performance": {
       "geo_metro": {"501": 1.8},
       "device_type": {"mobile": 1.8}
     }
   }
   ```

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

## Best Practices

1. **Report Frequently**: More data points improve optimization
2. **Use Confidence Scores**: Indicate statistical significance
3. **Break Down Performance**: Provide dimensional insights when possible
4. **Normalize Correctly**: 1.0 = baseline, not zero
5. **Consider Latency**: Some metrics may have attribution delays

## Future Enhancements

- **Real-time Streaming**: Push-based reporting for instant insights
- **Custom Metrics**: Publisher-defined performance indicators
- **Predictive Analytics**: Forecast performance based on patterns
- **Anomaly Detection**: Automatic alerts for unusual patterns
- **Attribution Models**: Flexible attribution windows and methods