---
sidebar_position: 4
title: Implementation Examples
---

# Audience Discovery Examples

This page demonstrates real-world usage of the Audience Discovery Protocol with detailed examples, including multi-platform discovery scenarios.

## Example 1: Nike Running Campaign (Single Platform)

Nike wants to find audiences interested in premium running gear for a new shoe launch on a specific platform.

### Step 1: Discovery

**Request**:
```json
{
  "audience_spec": "High-income runners and marathon enthusiasts who buy premium athletic gear",
  "deliver_to": {
    "platform": "scope3",
    "account": "nike_us_001",
    "countries": ["US", "CA"]
  },
  "filters": {
    "min_size": 500000,
    "max_cpm": 10.00
  },
  "max_results": 3
}
```

**Response**:
```json
{
  "audiences": [
    {
      "audience_agent_segment_id": "marathon_2024",
      "name": "Marathon Enthusiasts Premium",
      "description": "Runners who have completed marathons and purchase premium gear",
      "audience_type": "marketplace",
      "data_provider": "LiveRamp",
      "coverage_percentage": 35,
      "deployment": {
        "is_live": true,
        "scope": "account-specific",
        "decisioning_platform_segment_id": "scope3_nike_marathon_premium"
      },
      "pricing": {
        "cpm": 8.50,
        "currency": "USD"
      },
      "require_usage_reporting": true
    }
  ]
}
```

## Example 2: Peer39 Multi-Platform Discovery

An agency wants to discover Peer39's contextual segments across multiple SSPs for a luxury automotive campaign.

### Step 1: Multi-Platform Discovery

**Request**:
```json
{
  "audience_spec": "Luxury automotive content with high viewability and brand safety",
  "deliver_to": {
    "platforms": [
      {
        "platform": "index-exchange",
        "account": "omnicom-ix-main"
      },
      {
        "platform": "openx"
      },
      {
        "platform": "pubmatic",
        "account": "omnicom-pm-001"
      },
      {
        "platform": "magnite"
      }
    ],
    "countries": ["US", "CA"]
  },
  "filters": {
    "data_providers": ["Peer39"],
    "catalog_types": ["marketplace"],
    "min_coverage_percentage": 5
  },
  "max_results": 3
}
```

**Response**:
```json
{
  "audiences": [
    {
      "audience_agent_segment_id": "peer39_lux_auto_premium",
      "name": "Luxury Auto Premium Content",
      "description": "High-viewability pages featuring luxury automotive brands and content",
      "audience_type": "marketplace",
      "data_provider": "Peer39",
      "coverage_percentage": 12,
      "deployments": [
        {
          "platform": "index-exchange",
          "account": "omnicom-ix-main",
          "is_live": true,
          "scope": "account-specific",
          "decisioning_platform_segment_id": "ix_omni_peer39_lux_auto_v2"
        },
        {
          "platform": "index-exchange",
          "account": null,
          "is_live": true,
          "scope": "platform-wide",
          "decisioning_platform_segment_id": "ix_peer39_luxury_auto_general"
        },
        {
          "platform": "openx",
          "account": null,
          "is_live": true,
          "scope": "platform-wide",
          "decisioning_platform_segment_id": "ox_peer39_lux_auto_2024"
        },
        {
          "platform": "pubmatic",
          "account": "omnicom-pm-001",
          "is_live": false,
          "scope": "account-specific",
          "estimated_activation_duration_minutes": 60
        },
        {
          "platform": "magnite",
          "account": null,
          "is_live": true,
          "scope": "platform-wide",
          "decisioning_platform_segment_id": "mag_peer39_luxury_automotive"
        }
      ],
      "pricing": {
        "cpm": 2.50,
        "currency": "USD"
      },
      "require_usage_reporting": true
    },
    {
      "audience_agent_segment_id": "peer39_auto_research",
      "name": "Auto Research & Reviews",
      "description": "Pages with automotive research content, reviews, and comparisons",
      "audience_type": "marketplace",
      "data_provider": "Peer39",
      "coverage_percentage": 18,
      "deployments": [
        {
          "platform": "index-exchange",
          "account": null,
          "is_live": true,
          "scope": "platform-wide",
          "decisioning_platform_segment_id": "ix_peer39_auto_research"
        },
        {
          "platform": "openx",
          "account": null,
          "is_live": true,
          "scope": "platform-wide",
          "decisioning_platform_segment_id": "ox_peer39_auto_reviews_456"
        },
        {
          "platform": "pubmatic",
          "account": null,
          "is_live": false,
          "scope": "platform-wide",
          "estimated_activation_duration_minutes": 1440
        },
        {
          "platform": "magnite",
          "account": null,
          "is_live": false,
          "scope": "platform-wide",
          "estimated_activation_duration_minutes": 1440
        }
      ],
      "pricing": {
        "cpm": 2.00,
        "currency": "USD"
      },
      "require_usage_reporting": true
    }
  ]
}
```

### Step 2: Activation on PubMatic

The agency decides to activate the "Luxury Auto Premium Content" segment on PubMatic:

**Request**:
```json
{
  "audience_agent_segment_id": "peer39_lux_auto_premium",
  "platform": "pubmatic",
  "account": "omnicom-pm-001"
}
```

**Response**:
```json
{
  "decisioning_platform_segment_id": "pm_omni_peer39_lux_auto_activated",
  "estimated_activation_duration_minutes": 60
}
```

### Step 3: Usage Reporting Across Platforms

After running campaigns across multiple SSPs, report usage for each:

**Request (Index Exchange)**:
```json
{
  "reporting_date": "2025-01-21",
  "platform": "index-exchange",
  "account": "omnicom-ix-main",
  "usage": [
    {
      "audience_agent_segment_id": "peer39_lux_auto_premium",
      "decisioning_platform_segment_id": "ix_omni_peer39_lux_auto_v2",
      "active": true,
      "impressions": 3500000,
      "media_spend": 87500.00,
      "data_cost": 8750.00
    }
  ],
  "summary": {
    "total_impressions": 3500000,
    "total_media_spend": 87500.00,
    "total_data_cost": 8750.00,
    "unique_segments": 1
  }
}
```

**Request (OpenX)**:
```json
{
  "reporting_date": "2025-01-21",
  "platform": "openx",
  "account": null,
  "usage": [
    {
      "audience_agent_segment_id": "peer39_lux_auto_premium",
      "decisioning_platform_segment_id": "ox_peer39_lux_auto_2024",
      "active": true,
      "impressions": 2100000,
      "media_spend": 52500.00,
      "data_cost": 5250.00
    }
  ],
  "summary": {
    "total_impressions": 2100000,
    "total_media_spend": 52500.00,
    "total_data_cost": 5250.00,
    "unique_segments": 1
  }
}
```

## Example 3: Discover All Available Deployments

A trading desk wants to see all available deployments for a specific type of audience across all platforms.

### Request

```json
{
  "audience_spec": "B2B decision makers in technology companies",
  "deliver_to": {
    "platforms": "all",
    "countries": ["US", "GB", "DE"]
  },
  "filters": {
    "catalog_types": ["marketplace"],
    "min_coverage_percentage": 20
  },
  "max_results": 2
}
```

### Response

```json
{
  "audiences": [
    {
      "audience_agent_segment_id": "zoominfo_tech_decision_makers",
      "name": "Tech Company Decision Makers",
      "description": "C-level and VP-level executives at technology companies",
      "audience_type": "marketplace",
      "data_provider": "ZoomInfo",
      "coverage_percentage": 25,
      "deployments": [
        {
          "platform": "the-trade-desk",
          "account": null,
          "is_live": true,
          "scope": "platform-wide",
          "decisioning_platform_segment_id": "ttd_zoominfo_tech_execs"
        },
        {
          "platform": "amazon-dsp",
          "account": null,
          "is_live": true,
          "scope": "platform-wide",
          "decisioning_platform_segment_id": "amzn_zoom_tech_leaders"
        },
        {
          "platform": "google-dv360",
          "account": null,
          "is_live": false,
          "scope": "platform-wide",
          "estimated_activation_duration_minutes": 2880
        },
        {
          "platform": "index-exchange",
          "account": null,
          "is_live": true,
          "scope": "platform-wide",
          "decisioning_platform_segment_id": "ix_zoominfo_tech_dm"
        },
        {
          "platform": "openx",
          "account": null,
          "is_live": false,
          "scope": "platform-wide",
          "estimated_activation_duration_minutes": 1440
        }
      ],
      "pricing": {
        "cpm": null,
        "rev_share": 0.20,
        "currency": "USD"
      },
      "require_usage_reporting": true
    }
  ]
}
```

## Example 4: Mixed Public and Account-Specific Deployments

An agency has both public and custom segments available on the same platform.

### Request

```json
{
  "audience_spec": "Affluent sports enthusiasts",
  "deliver_to": {
    "platforms": [
      {
        "platform": "the-trade-desk",
        "account": "omnicom-ttd-main"
      }
    ],
    "countries": ["US"]
  }
}
```

### Response

```json
{
  "audiences": [
    {
      "audience_agent_segment_id": "sports_enthusiasts_base",
      "name": "Sports Enthusiasts",
      "description": "General sports audience",
      "audience_type": "marketplace",
      "data_provider": "Acxiom",
      "coverage_percentage": 40,
      "deployments": [
        {
          "platform": "the-trade-desk",
          "account": null,
          "is_live": true,
          "scope": "platform-wide",
          "decisioning_platform_segment_id": "ttd_acxiom_sports_general"
        },
        {
          "platform": "the-trade-desk",
          "account": "omnicom-ttd-main",
          "is_live": true,
          "scope": "account-specific",
          "decisioning_platform_segment_id": "ttd_omni_acxiom_sports_custom"
        }
      ],
      "pricing": {
        "cpm": 3.00,
        "currency": "USD"
      },
      "require_usage_reporting": true
    }
  ]
}
```

## Common Patterns

### 1. Platform-Specific Segment IDs

The same audience has different IDs on each platform:

```json
{
  "audience_agent_segment_id": "peer39_luxury_auto",
  "deployments": [
    { "platform": "index-exchange", "decisioning_platform_segment_id": "ix_peer39_lux_123" },
    { "platform": "openx", "decisioning_platform_segment_id": "ox_peer39_luxury_456" },
    { "platform": "pubmatic", "decisioning_platform_segment_id": "pm_peer39_auto_789" }
  ]
}
```

### 2. Account vs Platform-Wide Deployments

Same platform may have both options:

```json
{
  "deployments": [
    {
      "platform": "the-trade-desk",
      "account": null,
      "scope": "platform-wide",
      "decisioning_platform_segment_id": "ttd_general_segment"
    },
    {
      "platform": "the-trade-desk", 
      "account": "agency-account",
      "scope": "account-specific",
      "decisioning_platform_segment_id": "ttd_agency_custom_segment"
    }
  ]
}
```

### 3. Multi-Platform Usage Reporting

Report the same audience separately for each platform:

```json
// Day 1: Report for Index Exchange
{
  "platform": "index-exchange",
  "usage": [{
    "audience_agent_segment_id": "peer39_luxury_auto",
    "decisioning_platform_segment_id": "ix_peer39_lux_123",
    "impressions": 1000000
  }]
}

// Day 1: Report for OpenX (same audience, different platform)
{
  "platform": "openx",
  "usage": [{
    "audience_agent_segment_id": "peer39_luxury_auto",
    "decisioning_platform_segment_id": "ox_peer39_luxury_456",
    "impressions": 750000
  }]
}
```

## Best Practices

1. **Use multi-platform discovery** when you need audiences across multiple SSPs/DSPs
2. **Store platform-specific segment IDs** - they're different on each platform
3. **Check deployment status per platform** - some may be live while others need activation
4. **Report usage separately** for each platform, even for the same audience
5. **Consider account-specific segments** when available - they may have better rates or custom data
6. **Allow activation time** - some platforms activate faster than others (60 min vs 48 hours)
7. **Leverage "all" platforms** option to discover complete segment distribution