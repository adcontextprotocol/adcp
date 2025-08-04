---
title: Reporting & Optimization
---

# Reporting & Optimization

Reporting in AdCP:Buy leverages the same [Dimensions](dimensions.md) system used for targeting, enabling consistent analysis across the campaign lifecycle. This unified approach means you can report on exactly what you targeted.

## Delivery Reporting

The delivery reporting system provides real-time and historical performance data. See [`get_media_buy_delivery`](./tasks/get_media_buy_delivery) for detailed API documentation.

### Core Capabilities

- **Campaign-level metrics**: Total impressions, spend, clicks, conversions
- **Package breakdown**: Performance by individual packages/flights
- **Pacing analysis**: Track delivery against targets
- **Time-based reporting**: Specify custom date ranges

### Dimensional Reporting (Future)

Future versions will support rich dimensional breakdowns, allowing analysis by any combination of dimensions (geography, device, time, audience, etc.) with the same consistency as targeting.

## Performance Feedback Loop

The performance index system enables AI-driven optimization by feeding back business outcomes.

### Performance Index Concept

A normalized score indicating relative performance:
- `1.0` = Baseline/expected performance
- `> 1.0` = Above average (e.g., 1.45 = 45% better)
- `< 1.0` = Below average (e.g., 0.8 = 20% worse)

### How Publishers Use Performance Data

Publishers can leverage performance indices to:

1. **Optimize Delivery**: Shift impressions to high-performing segments
2. **Adjust Pricing**: Update CPMs based on proven value
3. **Improve Products**: Refine product definitions based on performance patterns
4. **Enhance Algorithms**: Train ML models on actual business outcomes

### Dimensional Performance (Proposed)

Future implementations may support dimensional performance feedback, allowing optimization at the intersection of multiple dimensions (e.g., "mobile users in NYC perform 80% above baseline").

## Reporting Consistency

The power of the unified dimension system:

### Target → Measure → Optimize

1. **Target**: Define your audience using dimensions
   - Example: "Mobile users in major metros"

2. **Measure**: Report on the same dimensions
   - Track performance by device type and geography

3. **Optimize**: Feed performance back to improve delivery
   - Shift budget to high-performing segments

This creates a virtuous cycle where targeting, measurement, and optimization all use the same dimensional framework.

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

1. **Report Frequently**: Regular reporting improves optimization opportunities
2. **Track Pacing**: Monitor delivery against targets to avoid under/over-delivery
3. **Analyze Patterns**: Look for performance trends across dimensions
4. **Consider Latency**: Some metrics may have attribution delays
5. **Normalize Metrics**: Use consistent baselines for performance comparison

## Platform Considerations

Different platforms offer varying reporting capabilities:

### Google Ad Manager
- Comprehensive dimensional reporting
- Real-time and historical data
- Advanced viewability metrics

### Kevel
- Real-time reporting API
- Custom metric support
- Flexible aggregation options

### Triton Digital
- Audio-specific metrics (completion rates, skip rates)
- Station-level performance data
- Daypart analysis

## Future Enhancements

- **Real-time Streaming**: Push-based reporting for instant insights
- **Custom Metrics**: Publisher-defined performance indicators
- **Predictive Analytics**: Forecast performance based on patterns
- **Anomaly Detection**: Automatic alerts for unusual patterns
- **Attribution Models**: Flexible attribution windows and methods
- **Cross-Media Measurement**: Unified reporting across channels

## Related Documentation

- [`get_media_buy_delivery`](./tasks/get_media_buy_delivery) - Retrieve delivery reports
- [Dimensions](./dimensions) - Understanding the dimension system
- [Targeting](./targeting) - How dimensions enable targeting