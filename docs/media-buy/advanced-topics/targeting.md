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

## When to Use Technical Targeting

Technical targeting overlays should be rare and used only for:

### Minor Adjustments
- **Frequency capping**: Basic impression suppression
- **Dayparting**: Simple time-of-day restrictions  
- **Exclusions**: Brand safety or competitive exclusions

### Platform Integration
- **Custom fields**: Platform-specific requirements not covered by briefs
- **Compliance**: Legal or regulatory targeting requirements

### Example Technical Overlay
```json
{
  "targeting_overlay": {
    "frequency_cap": {
      "suppress_minutes": 60
    },
    "dayparting": {
      "exclude_hours": [0, 1, 2, 3, 4, 5]  // Exclude overnight hours
    }
  }
}
```

## Integration with Dimensions

AdCP's [Dimensions](./dimensions) system provides the underlying structure for targeting, but briefs are the primary interface:

- **Dimensions define possibilities**: What targeting options exist
- **Briefs specify requirements**: What the buyer actually needs
- **Products deliver capabilities**: How publishers meet those requirements

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

## Best Practices

1. **Write Clear Briefs**: Be specific about audience and context requirements
2. **Trust Publisher Expertise**: Publishers know their inventory capabilities best
3. **Include AXE for Advanced Needs**: Use real-time decisioning for sophisticated targeting
4. **Minimize Technical Overlays**: Use only for simple adjustments or compliance
5. **Validate Audience Fit**: Ensure product descriptions match campaign goals

## Future Evolution

- **Enhanced Brief Processing**: More sophisticated natural language understanding
- **Audience Discovery**: Better tools for exploring available audiences
- **AXE Integration**: Deeper real-time targeting capabilities
- **Performance Optimization**: AI-driven audience refinement based on campaign results

## Related Documentation

- **[Dimensions](./dimensions)** - Understanding the underlying targeting structure
- **[Product Discovery](../product-discovery/)** - How briefs lead to targeted product recommendations
- **[Example Briefs](../product-discovery/example-briefs)** - Real examples of effective targeting briefs