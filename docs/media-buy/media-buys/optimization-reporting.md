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
The performance index system enables AI-driven optimization by feeding back business outcomes:

- **Performance Index**: A normalized score indicating relative performance:
  - `1.0` = Baseline/expected performance
  - `> 1.0` = Above average (e.g., 1.45 = 45% better)
  - `< 1.0` = Below average (e.g., 0.8 = 20% worse)
- **Conversion tracking**: Business outcome measurement
- **Learning algorithms**: AI-powered optimization recommendations

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