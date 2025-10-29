---
title: Targeting
---

# Targeting

AdCP's targeting philosophy centers on **brief-based targeting** where targeting requirements are communicated through natural language briefs, and publishers return products that include all necessary targeting capabilities.

## Core Principle: Targeting Through Briefs

The primary way to specify targeting in AdCP is through campaign briefs. Instead of configuring complex targeting parameters, buyers describe their audience requirements in plain language:

```json
{
  "brief": "We want to reach millennial parents (ages 25-40) in major US metro areas who are interested in sustainable products. Focus on mobile and desktop during evening hours when families are planning purchases."
}
```

Publishers then return products that include the targeting capabilities to reach this audience, with targeting costs built into the media pricing.

## Why Brief-Based Targeting?

### Eliminates Targeting Conflicts
- **Single source**: All targeting comes from the publisher's product definition
- **No layering conflicts**: Avoids multiple targeting systems competing
- **Pricing consistency**: Targeting costs are transparent and included in media prices

### Simplifies Implementation
- **Natural language**: Buyers describe needs in familiar terms
- **Publisher expertise**: Publishers know their inventory and audience capabilities best
- **Reduced complexity**: No need to learn platform-specific targeting syntax

### Enables Accurate Pricing
- **Inclusive pricing**: All targeting costs are built into the product price
- **No surprises**: Buyers know the complete cost upfront
- **Market-driven**: Pricing reflects true market value of targeted inventory

## Real-Time Decisioning with AXE

For advanced, real-time targeting needs, buyers can layer additional targeting through the **Agentic eXecution Engine (AXE)**:

- **Complements base targeting**: Works alongside publisher-defined targeting
- **Real-time decisions**: Dynamic audience selection based on live data
- **Avoids conflicts**: Designed to work within publisher targeting constraints
- **Premium capability**: Advanced targeting for sophisticated campaigns

## How Publishers Include Targeting

Publishers incorporate targeting capabilities directly into their product definitions:

### Geographic Targeting
Products specify geographic coverage:
```
"Chicago metro premium display package" 
"US national mobile video inventory"
"California lifestyle sites network"
```

### Demographic Targeting
Audience characteristics are built into products:
```
"Millennial-focused social media placements"
"Premium business professional network"
"Family-oriented content sites"
```

### Contextual Targeting
Content alignment is inherent in product descriptions:
```
"Sports content premium video inventory"
"Financial news site network"
"Entertainment property display package"
```

### Device & Platform Targeting
Technical specifications included in product format:
```
"Mobile-optimized video formats"
"Connected TV premium inventory"
"Desktop display network"
```

## Brief Examples for Common Targeting Needs

### Geographic Targeting
```json
{
  "brief": "Target users in New York, Los Angeles, and Chicago metro areas with premium display advertising for our luxury retail brand."
}
```

### Demographic Targeting
```json
{
  "brief": "Reach parents with children under 10 who are interested in educational content, focusing on weekend and evening viewing times."
}
```

### Contextual Targeting
```json
{
  "brief": "Place financial services ads adjacent to business and investment content, targeting affluent professionals during business hours."
}
```

### Behavioral Targeting
```json
{
  "brief": "Target users who have shown interest in sustainable products and eco-friendly brands, particularly those researching major purchases."
}
```

## Product Response Targeting Information

When publishers return products, they include targeting information buyers need:

```json
{
  "product_id": "premium_millennial_mobile",
  "name": "Premium Millennial Mobile Package",
  "description": "Mobile display inventory targeting millennials (25-40) across lifestyle and entertainment apps in top 25 US markets",
  "targeting_description": "Ages 25-40, household income $50K+, interests in lifestyle/entertainment, mobile apps only, top 25 US metro areas",
  "audience_size": "~2.5M monthly unique users",
  "pricing": {
    "cpm": 8.50,
    "targeting_included": true
  }
}
```

## When to Use Targeting Overlays

Targeting overlays in `create_media_buy` and `update_media_buy` are **rare** and should only be used for:

### Geographic Restrictions
Use geo fields **only** for:
- **RCT testing**: Randomized control trials requiring specific geographic splits
- **Regulatory compliance**: Legal requirements for geographic restrictions
- **Product refinement**: When a product spans multiple regions and you need to restrict to a subset

**Available fields**:
- `geo_country_any_of`: ISO country codes
- `geo_region_any_of`: State/region identifiers
- `geo_metro_any_of`: DMA codes (not all publishers support metro-level targeting)
- `geo_postal_code_any_of`: ZIP/postal codes (not all publishers support postal-level targeting)

**Note**: Not all geographic granularities are supported by all publishers. Country and region are most widely supported.

### Frequency Capping
Basic impression suppression controls:
```json
{
  "targeting_overlay": {
    "frequency_cap": {
      "suppress_minutes": 60  // Suppress for 60 minutes after impression
    }
  }
}
```

### Example Geographic Overlay (RCT Testing)
```json
{
  "packages": [
    {
      "buyer_ref": "test_group_a",
      "product_id": "national_video",
      "targeting_overlay": {
        "geo_metro_any_of": ["501", "602", "803"]  // Test DMAs
      }
    },
    {
      "buyer_ref": "test_group_b",
      "product_id": "national_video",
      "targeting_overlay": {
        "geo_metro_any_of": ["504", "505", "506"]  // Control DMAs
      }
    }
  ]
}
```

## What NOT to Use Targeting Overlays For

**Express these in briefs instead:**
- **Demographics** (age, gender) - "Target adults 25-54" in brief text
- **Device types** - "Mobile users" or "CTV viewers" in brief text
- **Browser/OS** - Rarely relevant; mention in brief if truly needed
- **Content categories** - "Sports content" or "News sites" in brief text
- **Audience segments** - "Auto intenders" or "Luxury shoppers" in brief text
- **Operating systems and browsers** - Mention in brief if needed
- **Language preferences** - "Spanish language content" in brief text
- **Daypart preferences** - "Morning commute hours" or "prime time evening" in brief text

**Why briefs work better:**
- Natural language captures intent more clearly
- Publishers know their inventory and can target effectively
- Avoids channel-specific complexity (DOOH has no browsers)
- Simpler API with fewer edge cases

## Available Targeting Overlay Parameters

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
- **Note**: Not all publishers support all region formats

### geo_metro_any_of
- **Description**: Restrict delivery to specific metro areas
- **Format**: DMA codes (US) or metro identifiers
- **Examples**: `["501", "803"]` (New York, Los Angeles DMAs)
- **Use cases**: Local campaigns, metro-level RCT testing
- **Note**: Not all publishers support metro-level targeting

### geo_postal_code_any_of
- **Description**: Restrict delivery to specific postal/ZIP codes
- **Format**: Country-specific postal codes
- **Examples**: `["10001", "10002"]`, `["90210"]`
- **Use cases**: Hyper-local campaigns, ZIP-level restrictions
- **Note**: Not all publishers support postal-level targeting

### frequency_cap
- **Description**: Limit ad exposure frequency per user
- **Format**: Frequency cap object with impressions, duration, and scope
- **Use cases**: Brand safety, user experience management
- **Example**: `{"impressions": 5, "duration_seconds": 86400, "scope": "creative"}`

## Benefits for Different Stakeholders

### For Buyers
- **Simpler planning**: Describe audience needs naturally
- **Transparent pricing**: All costs included upfront  
- **Reduced complexity**: No targeting configuration required
- **Better outcomes**: Publisher expertise optimizes delivery

### For Publishers
- **Pricing control**: Bundle targeting into product pricing
- **Expertise utilization**: Apply knowledge of inventory and audiences
- **Simplified integration**: Fewer technical targeting parameters
- **Market positioning**: Differentiate through targeting capabilities

### For Platforms
- **Reduced conflicts**: Single targeting source eliminates layering issues
- **Cleaner implementation**: Less complex targeting logic required
- **Better performance**: Optimized for publisher inventory characteristics

## Real-Time Targeting Signals

Orchestrators can provide **real-time targeting signals** to publishers for dynamic, high-cardinality targeting beyond what can be expressed in static overlays. These signals enable:

- **Brand safety** - Real-time content filtering and adjacency controls
- **Brand suitability** - Contextual alignment with brand values
- **Audience targeting** - Dynamic audience segments updated in real-time
- **Contextual targeting** - Page-level or moment-level targeting decisions

Real-time signals are provided through the [AdCP Signals Protocol](../../signals/overview), which allows orchestrators to supply targeting data at impression time.

### Key Differences: Signals vs Overlays

- Signals are **evaluated at impression time**, not campaign setup
- Signals support **higher cardinality** (thousands of values vs. dozens)
- Signals can be **updated continuously** without modifying the media buy
- Signals enable **sophisticated contextual targeting** that briefs cannot express

### When to Use Real-Time Signals

✅ **Use Real-Time Signals For:**
- Brand safety filtering (block unsafe content)
- Brand suitability scoring (prefer suitable contexts)
- Dynamic audience targeting (real-time segment membership)
- Contextual targeting (page-level or moment-level decisions)
- High-cardinality targeting (thousands of values)
- Targeting that changes during campaign flight

## Implementation Requirements

### Publishers MUST:

1. **Support Geographic Targeting**: Handle all four geographic parameters (country, region, metro, postal) to the extent your platform supports them
2. **Interpret Briefs**: Use briefs to determine appropriate audience and content targeting
3. **Validate Targeting**: Reject media buys with targeting that cannot be supported
4. **Document Limitations**: Clearly communicate any geographic targeting limitations in product descriptions

### Buyers SHOULD:

1. **Use Briefs First**: Express most targeting needs in natural language briefs
2. **Minimize Overlays**: Only use technical targeting for geographic restrictions or RCT testing
3. **Trust Publishers**: Let publishers apply their inventory knowledge to brief interpretation
4. **Validate Early**: Check product capabilities before applying technical targeting

## Best Practices

1. **Default to briefs** - Start with natural language descriptions
2. **Write Clear Briefs**: Be specific about audience and context requirements
3. **Trust Publisher Expertise**: Publishers know their inventory capabilities best
4. **Use signals for dynamic targeting** - Real-time signals handle complex, high-cardinality targeting better than overlays
5. **Minimize Technical Overlays**: Use only for geographic restrictions or compliance
6. **Validate Audience Fit**: Ensure product descriptions match campaign goals
7. **Inclusive pricing** - Expect targeting costs to be built into product rates

## Future Evolution

- **Enhanced Brief Processing**: More sophisticated natural language understanding
- **Audience Discovery**: Better tools for exploring available audiences
- **Deeper Signal Integration**: More sophisticated real-time targeting capabilities
- **Performance Optimization**: AI-driven audience refinement based on campaign results

## Related Documentation

- **[Signals Protocol](../../signals/overview)** - Real-time targeting signals for brand safety and contextual targeting
- **[Product Discovery](../product-discovery/)** - How briefs lead to targeted product recommendations
- **[Example Briefs](../product-discovery/example-briefs)** - Real examples of effective targeting briefs
- **[Policy Compliance](../media-buys/policy-compliance)** - Automated compliance checking and enforcement