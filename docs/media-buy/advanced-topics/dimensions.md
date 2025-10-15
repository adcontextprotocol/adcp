---
title: Targeting
---

# Targeting

AdCP follows a **brief-first targeting philosophy**: most targeting should be expressed in natural language briefs that publishers interpret using their expertise. Technical targeting overlays are minimized to only geographic restrictions needed for specific use cases.

## Targeting Philosophy

### Brief-First Approach

When creating a media buy, buyers provide a **brief** that describes:
- Who the campaign is trying to reach (demographics, interests, behaviors)
- What the campaign goals are
- Any content preferences or requirements

Publishers use their expertise to interpret these briefs and deliver against them. This approach:
- Leverages publisher knowledge of their inventory and audiences
- Reduces cross-platform targeting complexity
- Enables inclusive pricing (targeting costs built into rates)
- Simplifies cross-platform campaign management

**Example brief:**
```
Reach coffee enthusiasts aged 25-45 in urban areas who are interested in
sustainability and premium brands. Looking for morning dayparts when
users are most likely to be planning their day.
```

### Technical Targeting Overlays

Technical targeting parameters are available but should be used sparingly, primarily for:

1. **Regulatory compliance** - Geographic restrictions required by law
2. **RCT testing** - Randomized control trial geographic splits
3. **Geographic restrictions** - Hard requirements for specific locations

### Real-Time Targeting Signals

Orchestrators can provide **real-time targeting signals** to publishers for dynamic, high-cardinality targeting beyond what can be expressed in static overlays. These signals enable:

- **Brand safety** - Real-time content filtering and adjacency controls
- **Brand suitability** - Contextual alignment with brand values
- **Audience targeting** - Dynamic audience segments updated in real-time
- **Contextual targeting** - Page-level or moment-level targeting decisions

Real-time signals are provided through the AdCP Signals Extension, which allows orchestrators to supply targeting data at impression time. See [Signals Overview](../../signals/overview) for implementation details.

**Key differences from overlays:**
- Signals are **evaluated at impression time**, not campaign setup
- Signals support **higher cardinality** (thousands of values vs. dozens)
- Signals can be **updated continuously** without modifying the media buy
- Signals enable **sophisticated contextual targeting** that briefs cannot express

## Available Targeting Parameters

All targeting parameters use the `any_of` operator pattern for inclusive targeting.

### geo_country_any_of
- **Description**: Restrict delivery to specific countries
- **Format**: ISO 3166-1 alpha-2 country codes
- **Examples**: `["US", "CA"]`, `["GB", "FR", "DE"]`
- **Use cases**: Regulatory compliance, country-specific campaigns

### geo_region_any_of
- **Description**: Restrict delivery to specific regions/states
- **Format**: Region codes (interpretation depends on country)
- **Examples**: `["NY", "CA"]`, `["ON", "BC"]`
- **Use cases**: State-level compliance, regional testing

### geo_metro_any_of
- **Description**: Restrict delivery to specific metro areas
- **Format**: DMA codes (US) or metro identifiers
- **Examples**: `["501", "803"]` (New York, Los Angeles DMAs)
- **Use cases**: Local campaigns, metro-level RCT testing

### geo_postal_code_any_of
- **Description**: Restrict delivery to specific postal/ZIP codes
- **Format**: Country-specific postal codes
- **Examples**: `["10001", "10002"]`, `["90210"]`
- **Use cases**: Hyper-local campaigns, ZIP-level restrictions

### frequency_cap
- **Description**: Limit ad exposure frequency per user
- **Format**: Frequency cap object with impressions, duration, and scope
- **Use cases**: Brand safety, user experience management
- **Example**: `{"impressions": 5, "duration_seconds": 86400, "scope": "creative"}`

## Targeting Overlay Example

```json
{
  "brief": "Reach coffee enthusiasts aged 25-45...",
  "targeting": {
    "geo_country_any_of": ["US", "CA"],
    "geo_region_any_of": ["NY", "CA", "ON"],
    "frequency_cap": {
      "impressions": 5,
      "duration_seconds": 86400,
      "scope": "creative"
    }
  }
}
```

## What Goes in Briefs vs Technical Overlays vs Signals

### ✅ Express in Briefs
- Demographic targeting (age, gender, income)
- Interest and behavior targeting
- Device preferences (mobile, desktop, CTV)
- Content preferences (genres, categories, ratings)
- Daypart preferences (morning, evening, prime time)
- General audience segments (loyalty members, in-market audiences)
- Operating systems and browsers
- Language preferences

### ✅ Use Technical Overlays For
- Geographic restrictions (country, region, metro, postal)
- Frequency caps
- RCT test cell assignments

### ✅ Use Real-Time Signals For
- Brand safety filtering (block unsafe content)
- Brand suitability scoring (prefer suitable contexts)
- Dynamic audience targeting (real-time segment membership)
- Contextual targeting (page-level or moment-level decisions)
- High-cardinality targeting (thousands of values)
- Targeting that changes during campaign flight

## Best Practices

1. **Default to briefs** - Start with natural language descriptions
2. **Minimize overlays** - Only add technical targeting when absolutely necessary
3. **Use signals for dynamic targeting** - Real-time signals handle complex, high-cardinality targeting better than overlays
4. **Trust publisher expertise** - Publishers know their inventory and audiences best
5. **Inclusive pricing** - Expect targeting costs to be built into product rates

## Implementation Requirements

### Publishers MUST:

1. **Support Geographic Targeting**: Handle all four geographic dimensions (country, region, metro, postal)
2. **Interpret Briefs**: Use briefs to determine appropriate audience and content targeting
3. **Validate Targeting**: Reject media buys with targeting that cannot be supported
4. **Document Limitations**: Clearly communicate any geographic targeting limitations in product descriptions

### Buyers SHOULD:

1. **Use Briefs First**: Express most targeting needs in natural language briefs
2. **Minimize Overlays**: Only use technical targeting for geographic restrictions or RCT testing
3. **Trust Publishers**: Let publishers apply their inventory knowledge to brief interpretation
4. **Validate Early**: Check product capabilities before applying technical targeting