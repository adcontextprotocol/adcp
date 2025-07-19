---
sidebar_position: 3
title: Quick Reference
---

# Audience Protocol Quick Reference

## Tools at a Glance

| Tool | Purpose | Key Fields |
|------|---------|------------|
| `get_audiences` | Search for audiences | `prompt`, `platform`, `seat` |
| `activate_audience` | Turn on an audience | `segment_id`, `platform`, `seat` |
| `check_audience_status` | Check deployment | `segment_id` |
| `report_usage` | Report for billing | `reporting_date`, `usage[]` |

## Request Examples

### Find Audiences
```json
{
  "prompt": "affluent sports fans interested in running",
  "platform": "scope3",
  "filters": {
    "min_size": 100000,
    "max_cpm": 5.00
  }
}
```

### Activate Audience
```json
{
  "segment_id": "seg_12345",
  "platform": "scope3",
  "seat": "nike_us_001"
}
```

### Report Usage
```json
{
  "reporting_date": "2025-01-20",
  "platform": "scope3",
  "usage": [{
    "segment_id": "seg_12345",
    "impressions": 1000000,
    "data_cost": 3500.00
  }]
}
```

## Response Patterns

### Live Audience
```json
{
  "deployment": {
    "is_live": true,
    "platform": "scope3"
  }
}
```

### Needs Activation
```json
{
  "deployment": {
    "is_live": false,
    "estimated_activation_time": "24-48 hours"
  }
}
```

## Pricing Models

| Type | Example | Use Case |
|------|---------|----------|
| CPM Only | `"cpm": 2.50, "rev_share": null` | Predictable costs |
| Rev Share Only | `"cpm": null, "rev_share": 0.15` | Percentage of spend |
| Both | `"cpm": 5.00, "rev_share": 0.12` | Choose best option |
| Free | `"cpm": null, "rev_share": null` | Owned/included |

## Size Units

- **individuals**: Actual people (2.5M individuals)
- **devices**: Cookies/IDs (15M devices)  
- **households**: Homes (850K households)

## Common Errors

| Code | Meaning | Action |
|------|---------|--------|
| `SEGMENT_NOT_FOUND` | Bad segment_id | Check get_audiences response |
| `ALREADY_ACTIVATED` | Already live | Use immediately |
| `DEPLOYMENT_UNAUTHORIZED` | Wrong platform/seat | Check permissions |