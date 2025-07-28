---
title: Targeting
---

# Targeting

Targeting in AdCP:Buy builds upon the [Dimensions](dimensions.md) system to specify audience selection criteria. While dimensions define the available attributes, targeting applies filters using those dimensions to reach specific audiences.

## Targeting Model

The targeting model uses a consistent pattern across all dimensions:

- **`{dimension}_any_of`**: Include any records matching these values (OR logic)
- **`{dimension}_none_of`**: Exclude all records matching these values

This pattern provides clear, predictable behavior across all targeting dimensions.

## Standard Targeting Fields

Based on the standard dimensions, these targeting fields are available:

### Geographic Targeting
- `geo_country_any_of` / `geo_country_none_of`
- `geo_region_any_of` / `geo_region_none_of`
- `geo_metro_any_of` / `geo_metro_none_of`
- `geo_city_any_of` / `geo_city_none_of`
- `geo_postal_any_of` / `geo_postal_none_of`

### Device & Technology Targeting
- `device_type_any_of` / `device_type_none_of`
- `os_any_of` / `os_none_of`
- `browser_any_of` / `browser_none_of`
- `connection_type_any_of` / `connection_type_none_of`

### Content & Contextual Targeting
- `content_category_any_of` / `content_category_none_of`
- `content_genre_any_of` / `content_genre_none_of`
- `content_rating_any_of` / `content_rating_none_of`
- `language_any_of` / `language_none_of`

### Audience Targeting
- `audience_segment_any_of` / `audience_segment_none_of`

### Media Type Targeting
- `media_type_any_of` / `media_type_none_of`

## Special Targeting Types

Some targeting types require structured data beyond simple include/exclude lists:

### Dayparting

Time-based targeting uses a structured schedule format:

```json
{
  "dayparting": {
    "timezone": "America/New_York",
    "schedules": [
      {
        "days": [1, 2, 3, 4, 5],  // Monday-Friday
        "start_hour": 6,
        "end_hour": 10
      }
    ]
  }
}
```

### Frequency Capping

Impression frequency limits use a structured format:

```json
{
  "frequency_cap": {
    "impressions": 5,
    "period": "day",  // hour, day, week, month, lifetime
    "per": "user"     // user, ip, household, device
  }
}
```

### Custom Platform Targeting

Platform-specific targeting that doesn't map to standard dimensions:

```json
{
  "custom": {
    "gam": {
      "key_values": {"section": ["sports", "news"]},
      "inventory_targeting": {"ad_unit_ids": ["123", "456"]}
    }
  }
}
```

## Layered Application

Targeting is applied in two layers:

### 1. Product Targeting Template

Products define their base audience:

```json
{
  "product_id": "premium_sports_video",
  "targeting_template": {
    "content_category_any_of": ["IAB17"],  // Sports
    "device_type_any_of": ["ctv", "desktop"],
    "media_type_any_of": ["video"]
  }
}
```

### 2. Media Buy Targeting Overlay

Media buys can refine the targeting:

```json
{
  "targeting_overlay": {
    "geo_country_any_of": ["US"],
    "geo_region_any_of": ["CA", "NY"],
    "audience_segment_any_of": ["3p:sports_fans"],
    "frequency_cap": {
      "impressions": 3,
      "period": "day",
      "per": "user"
    }
  }
}
```

### 3. Final Effective Targeting

The system combines both layers:
- Lists are merged (union for `any_of`, union for `none_of`)
- Structured fields use the most specific value
- Custom fields are merged by platform

## Platform Compatibility

Not all platforms support all targeting dimensions. When unsupported targeting is requested:

1. **Validation**: Adapters check targeting against their capabilities
2. **Rejection**: Create/update requests fail with clear error messages
3. **Decision**: Buyers can modify targeting or choose a different platform

Example error:
```json
{
  "error": "Unsupported targeting features for Kevel",
  "details": [
    "Device type 'ctv' not supported (supported: mobile, desktop, tablet)",
    "Dayparting not supported by Kevel"
  ]
}
```

## Examples

### Basic Geographic and Device Targeting

```json
{
  "geo_country_any_of": ["US"],
  "geo_region_any_of": ["CA", "NY", "TX"],
  "device_type_any_of": ["mobile", "tablet"],
  "os_any_of": ["iOS", "Android"]
}
```

### Advanced Multi-Dimensional Targeting

```json
{
  "geo_metro_any_of": ["501", "803"],  // NYC, LA
  "device_type_any_of": ["ctv"],
  "content_category_any_of": ["IAB17", "IAB19"],  // Sports, Tech
  "audience_segment_any_of": ["1p:high_value", "3p:sports_fans"],
  "dayparting": {
    "timezone": "America/New_York",
    "schedules": [
      {
        "days": [0, 6],  // Weekends
        "start_hour": 10,
        "end_hour": 22
      }
    ]
  },
  "frequency_cap": {
    "impressions": 5,
    "period": "week",
    "per": "household"
  }
}
```

### Audio-Specific Targeting

```json
{
  "media_type_any_of": ["audio"],
  "device_type_any_of": ["mobile", "desktop", "audio"],
  "content_genre_any_of": ["music", "talk", "sports"],
  "dayparting": {
    "timezone": "America/New_York",
    "schedules": [
      {
        "days": [1, 2, 3, 4, 5],
        "start_hour": 6,
        "end_hour": 10  // Morning drive time
      }
    ]
  },
  "custom": {
    "triton": {
      "station_ids": ["WABC-FM", "WXYZ-AM"],
      "stream_types": ["live", "podcast"]
    }
  }
}
```

## Best Practices

1. **Validate Support**: Check platform capabilities before creating media buys
2. **Start Broad**: Begin with fewer restrictions and refine based on performance
3. **Use Standard Dimensions**: Prefer standard over custom targeting when possible
4. **Layer Thoughtfully**: Use product templates for common criteria, overlays for campaign-specific needs
5. **Monitor Compatibility**: Pay attention to platform warnings and errors

## Future Enhancements

- **Targeting Templates**: Reusable targeting presets
- **Audience Discovery**: API to browse available audience segments
- **Cross-Device Targeting**: Unified user targeting across devices
- **Contextual AI**: ML-based contextual targeting options