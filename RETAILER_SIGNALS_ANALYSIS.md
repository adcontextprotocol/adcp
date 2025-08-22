# Retailer Signals Protocol Analysis

## Executive Summary

After analyzing the retailer pricing requirements against both the Signals Activation Protocol and the Media Buy Protocol, I recommend that **retail media networks should be implemented as Media Products rather than standalone Signals**. This approach leverages existing protocol capabilities and naturally handles the complex business rules, minimum spends, and advertiser-specific requirements that retailers have.

## Why Media Products Make More Sense

### 1. Natural Fit for Retailer Business Model

Retailers aren't selling standalone audiences - they're selling **media packages** that bundle:
- Inventory (onsite or offsite)
- Audience targeting
- Measurement capabilities
- Creative requirements
- Channel restrictions

This aligns perfectly with the Media Products model.

### 2. Existing Protocol Capabilities Match Requirements

| Retailer Requirement | Media Products Solution |
|---------------------|------------------------|
| **Minimum Spend** | Products already have `min_spend` field |
| **Endemic vs Non-Endemic** | `promoted_offering` identifies the advertiser and product category |
| **Channel Restrictions** | Products specify `formats` which map to channels |
| **Pricing Tiers** | Different products for different audience tiers |
| **Custom Audiences** | `is_custom` products with `expires_at` |
| **Approval Workflows** | Built into `create_media_buy` response |
| **Co-branding Requirements** | Can be specified in product `description` and enforced at creative upload |
| **Measurement Bundling** | Included in product offering |

### 3. How It Would Work

#### Product Discovery
```json
{
  "brief": "Target pet owners using Albertsons shopper data",
  "promoted_offering": "Purina Pro Plan dog food",  // Identifies endemic advertiser
  "filters": {
    "delivery_type": "guaranteed"
  }
}
```

#### Retailer Returns Tiered Products
```json
{
  "products": [
    {
      "product_id": "albertsons_syndicated_pet_category",
      "name": "Albertsons Pet Category Shoppers",
      "description": "Offsite targeting of Albertsons shoppers who buy pet products. 30% of media price, capped at $3.50 CPM. Includes measurement. Must drive to Albertsons.com.",
      "formats": [
        {"format_id": "display_standard"},
        {"format_id": "video_standard"},
        {"format_id": "ctv_standard"}
      ],
      "delivery_type": "guaranteed",
      "is_fixed_price": false,  // Uses percentage pricing
      "cpm": 3.50,  // Cap price
      "min_spend": 10000,
      "metadata": {
        "audience_tier": "syndicated_category",
        "pricing_model": "revenue_share_capped",
        "revenue_share": 0.30,
        "requires_co_branding": false,
        "measurement_included": true
      }
    },
    {
      "product_id": "albertsons_custom_purina_buyers",
      "name": "Custom: Competitive Dog Food Buyers",
      "description": "Custom audience of shoppers who buy competitive dog food brands. 45% of media, capped at $5 CPM. Requires $50K minimum. Includes measurement.",
      "formats": [
        {"format_id": "display_standard"},
        {"format_id": "video_standard"}
      ],
      "delivery_type": "guaranteed",
      "is_fixed_price": false,
      "cpm": 5.00,  // Cap price
      "min_spend": 50000,  // Custom audience minimum
      "is_custom": true,
      "expires_at": "2025-02-15T00:00:00Z",
      "metadata": {
        "audience_tier": "custom",
        "pricing_model": "revenue_share_capped",
        "revenue_share": 0.45,
        "requires_approval": true
      }
    }
  ]
}
```

### 4. Advertiser Type Detection

The `promoted_offering` field naturally identifies:
- **Endemic**: "Purina Pro Plan dog food" → Sells at Albertsons
- **Non-Endemic**: "State Farm Insurance" → Doesn't sell at Albertsons

Retailers can return different products or pricing based on this.

### 5. Enforcement Through Media Buy Creation

```json
{
  "packages": ["albertsons_custom_purina_buyers"],
  "promoted_offering": "Purina Pro Plan dog food",
  "total_budget": 75000,  // Meets $50K minimum
  "targeting_overlay": {
    "signals": ["albertsons_pet_buyers_q1"]  // Signal gets activated as part of media buy
  }
}
```

Response validates all requirements:
```json
{
  "message": "Media buy created successfully. Custom audience 'Competitive Dog Food Buyers' will be activated within 24 hours. Creative must include Albertsons.com as landing page. Measurement dashboard will be available after first impressions.",
  "media_buy_id": "albertsons_mb_123",
  "requirements": {
    "landing_page": "must_include_albertsons.com",
    "prohibited_categories": ["alcohol"],
    "measurement_included": true
  }
}
```

## Minimal Protocol Enhancements Needed

While Media Products handle most requirements, small enhancements would complete the picture:

### 1. Structured Metadata Field for Products

Add optional `metadata` field to products for machine-readable requirements:

```json
{
  "metadata": {
    "audience_tier": "syndicated_category",
    "pricing_model": "revenue_share_capped",
    "revenue_share": 0.30,
    "endemic_only": false,
    "requires_co_branding": true,
    "landing_page_requirements": "retailer_site",
    "prohibited_categories": ["alcohol", "pharmaceutical"],
    "measurement_included": true,
    "jbp_eligible": true
  }
}
```

### 2. Enhanced Pricing Models

Extend pricing to support percentage with cap:

```json
{
  "pricing": {
    "model": "revenue_share_capped",
    "revenue_share": 0.30,
    "cpm_cap": 3.50
  }
}
```

### 3. Signal Integration in Targeting Overlay

Already supported! The `targeting_overlay.signals` field in `create_media_buy` can reference signals that get activated as part of the media buy.

## Implementation Advantages

### For Retailers
1. **Natural enforcement** of minimums and requirements
2. **Bundle everything** (media + data + measurement)
3. **Dynamic pricing** based on advertiser type
4. **Existing approval workflows** work out of the box

### For Protocol
1. **No breaking changes** - uses existing structures
2. **Cleaner separation** - Signals for pure data, Products for retail media
3. **Simpler implementation** - Reuses existing concepts

### For Buyers
1. **Clear pricing** - See total cost upfront
2. **Bundled value** - Everything included in one product
3. **Familiar model** - Like buying any other media product

## Migration Path

1. **Phase 1**: Retailers expose their offerings as Media Products
2. **Phase 2**: Add metadata field for structured requirements
3. **Phase 3**: Enhance pricing models for percentage + cap
4. **Phase 4**: Deprecate standalone signal activation for retail use cases

## Conclusion

Using Media Products for retail media networks is the right approach because:

1. **It matches the business model** - Retailers sell media packages, not just data
2. **Protocol already supports it** - Most capabilities exist today
3. **Natural enforcement** - Minimums, restrictions, and requirements fit naturally
4. **Promoted offering** - Already identifies advertiser type for endemic/non-endemic logic
5. **Cleaner architecture** - Signals remain pure data plays, Products handle commercial bundles

The only enhancements needed are:
- Optional metadata field for machine-readable requirements  
- Extended pricing model for percentage + cap
- Both backward compatible additions

This approach makes AdCP immediately suitable for the $100B+ retail media market without major protocol changes.