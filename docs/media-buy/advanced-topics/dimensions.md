---
title: Dimensions
---

# Dimensions

Dimensions are the fundamental building blocks of the AdCP system. They represent attributes that can be used across three key areas:

1. **Product Definition**: What inventory is being offered
2. **Targeting**: Who should see the ads
3. **Reporting**: How delivery is analyzed

By using a unified dimension system, AdCP ensures consistency and enables powerful cross-functional capabilities like "report on the same dimensions you targeted."

## Dimension Categories

### Required Dimensions

All AdCP implementations MUST support these dimensions with standardized values:

#### geo_country
- **Description**: ISO 3166-1 alpha-2 country codes
- **Examples**: `"US"`, `"CA"`, `"GB"`, `"FR"`
- **Usage**: Universal geographic targeting and reporting

#### media_type
- **Description**: The format of advertising inventory
- **Values**: `"video"`, `"audio"`, `"display"`, `"native"`, `"dooh"`
- **Usage**: Fundamental to product definition and creative compatibility

#### date_time
- **Description**: Temporal dimension for scheduling and reporting
- **Format**: ISO 8601 timestamps
- **Usage**: Campaign scheduling, dayparting, historical reporting

### Standard Optional Dimensions

These dimensions are optional, but if supported, MUST use these standardized definitions:

#### geo_region
- **Description**: Sub-national administrative divisions
- **Format**: Two-letter codes without country prefix
- **Examples**: `"NY"`, `"CA"`, `"ON"`, `"BC"`
- **Note**: Interpretation depends on geo_country context

#### geo_metro
- **Description**: Metropolitan/DMA areas
- **Format**: Numeric strings (US uses DMA codes)
- **Examples**: `"501"` (New York), `"803"` (Los Angeles)

#### geo_city
- **Description**: City names
- **Format**: Plain text city name
- **Examples**: `"New York"`, `"Los Angeles"`, `"Toronto"`

#### geo_postal
- **Description**: Postal/ZIP codes
- **Format**: Country-specific postal codes
- **Examples**: `"10001"`, `"90210"`, `"M5H 2N2"`

#### device_type
- **Description**: Device categories
- **Values**: `"mobile"`, `"desktop"`, `"tablet"`, `"ctv"`, `"audio"`, `"dooh"`, `"wearable"`
- **Note**: Some overlap with media_type is intentional

#### os
- **Description**: Operating systems
- **Format**: Capitalized common names
- **Examples**: `"iOS"`, `"Android"`, `"Windows"`, `"macOS"`, `"Linux"`

#### browser
- **Description**: Web browsers
- **Format**: Capitalized common names
- **Examples**: `"Chrome"`, `"Safari"`, `"Firefox"`, `"Edge"`

#### content_category
- **Description**: IAB Content Taxonomy categories
- **Format**: IAB category IDs
- **Examples**: `"IAB17"` (Sports), `"IAB19"` (Technology)

#### audience_segment
- **Description**: Audience targeting segments
- **Format**: Provider-prefixed identifiers
- **Examples**: `"1p:loyalty_members"`, `"3p:auto_intenders"`

#### language
- **Description**: ISO 639-1 language codes
- **Examples**: `"en"`, `"es"`, `"fr"`

#### day_part
- **Description**: Time-of-day segments
- **Standard Values**: 
  - `"early_morning"` (5-8am)
  - `"morning"` (8-12pm)
  - `"afternoon"` (12-5pm)
  - `"evening"` (5-8pm)
  - `"prime_time"` (8-11pm)
  - `"late_night"` (11pm-2am)
  - `"overnight"` (2-5am)
- **Note**: Publishers may define custom values

#### content_rating
- **Description**: Content maturity ratings
- **Examples**: `"G"`, `"PG"`, `"PG-13"`, `"R"`, `"TV-Y"`, `"TV-14"`

#### content_genre
- **Description**: Content genres
- **Examples**: `"news"`, `"sports"`, `"drama"`, `"comedy"`, `"music"`

#### connection_type
- **Description**: Network connection types
- **Values**: `"ethernet"`, `"wifi"`, `"cellular"`, `"unknown"`

### Platform-Specific Dimensions

Platforms may define additional dimensions prefixed with their identifier:

```json
{
  "gam:custom_key": ["value1", "value2"],
  "kevel:zone_id": ["123", "456"],
  "triton:station_id": ["WABC-FM", "WXYZ-AM"]
}
```

## Dimension Usage

### In Product Definition

Products use dimensions to describe their inventory:

```json
{
  "product_id": "mobile_sports_video",
  "name": "Mobile Sports Video",
  "media_type": "video",
  "dimensions": {
    "content_category": ["IAB17"],
    "device_type": ["mobile"],
    "content_genre": ["sports"]
  }
}
```

### In Targeting

**Note**: Most targeting should be expressed in briefs, not as technical overlays. See [Targeting](./targeting) for details on AdCP's brief-first approach.

When targeting overlays are used (rare cases like RCT testing), they use dimensions with any_of/none_of operators:

```json
{
  "geo_country_any_of": ["US", "CA"],
  "geo_region_any_of": ["NY", "CA"],
  "geo_metro_any_of": ["501", "803"]
}
```

Dimensions like `device_type`, `browser`, `os`, `content_category`, and audience segments should be specified in briefs rather than as targeting overlays.

### In Reporting

Reports aggregate metrics by dimensions:

```json
{
  "dimensions": ["date", "geo_metro", "device_type"],
  "metrics": ["impressions", "spend", "ctr"],
  "filters": {
    "geo_country_any_of": ["US"]
  }
}
```

## Implementation Requirements

### Adapters MUST:

1. **Translate Values**: Convert between AdCP standard values and platform-specific values
2. **Validate Support**: Reject operations using unsupported dimensions
3. **Document Mappings**: Clearly document how AdCP dimensions map to platform concepts
4. **Preserve Fidelity**: Maintain dimension granularity in reporting

### Example Adapter Mapping

```python
class MyAdapter:
    # Dimension support declaration
    SUPPORTED_DIMENSIONS = {
        "geo_country": True,
        "geo_region": True,
        "geo_metro": True,
        "device_type": ["mobile", "desktop", "tablet"],  # Subset
        "media_type": ["display", "video"],
        "day_part": False  # Not supported
    }
    
    # Value mappings
    DEVICE_TYPE_MAP = {
        "mobile": "MOBILE_PHONE",
        "tablet": "TABLET_DEVICE",
        "desktop": "PERSONAL_COMPUTER"
    }
```

## Best Practices

1. **Start with Products**: Let product definitions drive which dimensions matter
2. **Validate Early**: Check dimension support before creating media buys
3. **Report Consistently**: Use the same dimension values in reporting as in targeting
4. **Document Custom**: Clearly document any platform-specific dimensions
5. **Prefer Standard**: Use standard dimensions over custom when possible

## Future Considerations

- **Dimension Discovery**: API to query supported dimensions and values
- **Dimension Hierarchies**: Define relationships (city → metro → region → country)
- **Cross-Dimension Rules**: Express dependencies between dimensions
- **Dynamic Values**: Support for real-time value discovery (e.g., available audiences)