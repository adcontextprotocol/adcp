---
title: Media Products & Discovery
---

# Media Products & Discovery

A **Product** is the core sellable unit in AdCP. This document details the Product model, including its pricing and delivery types, and the pluggable catalog system that enables intelligent product discovery based on advertising briefs.

## The Product Model

- `product_id` (string, required)
- `name` (string, required)
- `description` (string, required)
- `formats` (list[Format], required): See [Creative Formats](creative-formats.md).
- `implementation_config` (JSON, required): Ad server-specific configuration containing everything needed to create the media buy (placement IDs, ad unit paths, targeting keys, etc.).
- `delivery_type` (string, required): Either `"guaranteed"` or `"non_guaranteed"`.
- `is_fixed_price` (bool, required): `true` if the price is fixed, `false` if it is auction-based.
- `cpm` (float, optional): The fixed Cost Per Mille. **Required** if `is_fixed_price` is `true`.
- `price_guidance` (PriceGuidance, optional): Pricing guidance for auction-based products. **Required** if `is_fixed_price` is `false`.
- `is_custom` (bool, optional): `true` if the product was generated for a specific brief.
- `expires_at` (datetime, optional): If `is_custom`, the time the product is no longer valid.

### Pricing Models

AdCP supports two pricing models, determined by the `is_fixed_price` flag.

#### Guaranteed, Fixed-Price Products
These products represent reserved inventory with a predictable price and delivery.
- `delivery_type`: `"guaranteed"`
- `is_fixed_price`: `true`
- `cpm`: A fixed float value (e.g., `45.00`).

#### Non-Guaranteed, Variable-Price Products
These products represent inventory available in an auction. The final price is not fixed.
- `delivery_type`: `"non_guaranteed"`
- `is_fixed_price`: `false`
- `price_guidance`: A `PriceGuidance` object that helps the buyer make an informed bid.

**Example `PriceGuidance`:**
```json
{
  "floor": 10.00,
  "p25": 12.50,
  "p50": 15.00,
  "p75": 18.00,
  "p90": 22.00
}
```

### Custom & Principal-Specific Products

A server can offer a general catalog, but it can also return:
- **Principal-Specific Products**: If a `principal_id` is sent in the `list_products` request, the server can return products reserved for or negotiated with that specific client.
- **Custom Products**: The server can generate new, temporary products in response to a `brief`, returning them with `is_custom: true` and an `expires_at` timestamp. This allows for maximum flexibility without cluttering the main catalog.

## Pluggable Product Catalog System

AdCP supports a flexible, pluggable catalog system that allows publishers to expose their products through different providers:

### Provider Types

1. **Database Provider**: Returns products from a static database
   - Simple and predictable
   - Best for fixed inventory with standard products
   - No dynamic matching based on briefs

2. **AI Provider** (e.g., Gemini): Uses AI to intelligently match products to briefs
   - Analyzes the advertising brief to understand intent
   - Returns products ranked by relevance
   - Can generate custom products on-demand
   - Provides match reasons explaining recommendations

3. **MCP Provider** (Upstream): Connects to upstream catalog servers
   - Passes full principal context to upstream servers
   - Enables publisher-specific product catalogs
   - Supports custom authentication headers
   - Allows for federated product discovery

### Principal Context in Upstream Requests

When using the MCP provider, the full principal object is passed to upstream servers, including:
- Principal ID and organization details
- Ad server account mappings (e.g., GAM account IDs)
- Historical campaign data
- Negotiated terms and pricing

Upstream servers can use this context to:
- Verify the advertiser has an account on the publisher's ad server
- Apply advertiser-specific pricing or terms
- Customize products based on advertiser history
- Return only products the advertiser is authorized to purchase

### Implementation Config

The `implementation_config` field is crucial for the correct architecture flow:

1. **Publisher Setup**: Publisher configures products on their ad server (e.g., Yahoo uses GAM)
2. **Product Definition**: Each product includes `implementation_config` with ad server-specific details:
   ```json
   {
     "implementation_config": {
       "gam": {
         "placement_ids": ["123456", "789012"],
         "ad_unit_paths": ["/homepage/top", "/homepage/sidebar"],
         "targeting_keys": {
           "section": "news",
           "position": "above_fold"
         }
       }
     }
   }
   ```
3. **Discovery**: Advertiser requests products via `list_products` with a brief
4. **Selection**: Catalog provider returns relevant products with implementation details
5. **Purchase**: Advertiser calls `create_media_buy` with selected product IDs
6. **Execution**: Adapter uses advertiser's ad server ID + product's `implementation_config` to create the campaign

## Product Discovery Lifecycle

The product discovery process is designed to be intuitive and AI-friendly, allowing buyers to find relevant inventory using natural language:

### 1. Natural Language Discovery (`discover_products`)

The discovery process starts with a natural language brief that describes the campaign objectives:

```json
{
  "campaign_brief": "I want to reach pet owners in California with video ads during prime time"
}
```

The system uses AI to interpret this brief and match it against available inventory, returning relevant products with:
- **Match scores**: How well each product aligns with the brief
- **Match reasons**: Why each product was recommended
- **Product details**: Pricing, targeting capabilities, and formats

### 2. Discovery Response

The system returns products ranked by relevance:

```json
{
  "recommended_products": [
    {
      "product_id": "connected_tv_prime",
      "name": "Connected TV - Prime Time",
      "description": "Premium CTV inventory 8PM-11PM PST",
      "min_spend": 10000,
      "cpm_range": {
        "min": 35.00,
        "max": 65.00
      },
      "match_reasons": [
        "Prime time daypart matches request",
        "CTV reaches pet owner households", 
        "California geo-targeting available"
      ],
      "relevance_score": 0.92
    }
  ]
}
```

### 3. Product Catalog Browsing (`list_products`)

Buyers can browse the full product catalog with filters and principal context:

```json
{
  "principal": {
    "principal_id": "nike",
    "organization": "Nike Inc.",
    "ad_server_mappings": {
      "gam": {
        "network_code": "123456",
        "advertiser_id": "nike_sports_2024"
      }
    }
  },
  "brief": "Looking for premium sports inventory",
  "category": "video",
  "min_budget": 5000,
  "formats": ["video"]
}
```

The catalog provider uses this information to return:
- Products matching the brief intent
- Principal-specific negotiated rates
- Only products the advertiser can actually purchase
- Custom products tailored to their needs

### 4. Custom Product Generation

For unique requirements, the system can generate custom products on-demand:

1. **Brief Analysis**: The AI analyzes requirements that don't match existing products
2. **Custom Creation**: New products are created with `is_custom: true`
3. **Expiration**: Custom products include `expires_at` to prevent catalog bloat
4. **Pricing**: Custom pricing based on the specific requirements

### Standard Run-of-Site Products

Every publisher should offer standard products that advertisers expect:

1. **Display Products**:
   - Homepage takeover
   - Run of site banner
   - Mobile interstitial
   - Native content units

2. **Video Products**:
   - Pre-roll video
   - Mid-roll video
   - Connected TV spots
   - Outstream video

3. **Audio Products**:
   - Podcast pre-roll
   - Streaming audio spots
   - Voice assistant placements

### Discovery Best Practices

1. **Configure Appropriate Provider**: Choose the catalog provider that matches your needs
2. **Include Principal Context**: Always pass principal information for personalized results
3. **Use Natural Language Briefs**: Let AI providers understand campaign intent
4. **Leverage Implementation Config**: Ensure products include all necessary ad server details
5. **Consider Custom Products**: For unique campaigns, use AI providers that can generate custom products

### Complete Architecture Example

Here's a real-world example of how the pluggable catalog system works:

**Scenario**: Nike wants to buy premium sports inventory on Yahoo, which uses Google Ad Manager (GAM).

1. **Yahoo's Product Setup**:
```json
{
  "product_id": "yahoo_sports_premium",
  "name": "Yahoo Sports - Premium Inventory",
  "description": "High-impact placements on Yahoo Sports",
  "formats": [{
    "format_id": "display_leaderboard",
    "name": "Leaderboard Banner"
  }],
  "implementation_config": {
    "gam": {
      "network_code": "yahoo_network_123",
      "placement_ids": ["sports_top_728x90"],
      "ad_unit_paths": ["/sports/homepage/top"],
      "targeting_keys": {
        "section": "sports",
        "content_type": "article"
      }
    }
  },
  "delivery_type": "guaranteed",
  "is_fixed_price": true,
  "cpm": 25.00
}
```

2. **Nike's Discovery Request** (via MCP upstream provider):
```json
{
  "principal": {
    "principal_id": "nike",
    "organization": "Nike Inc.",
    "ad_server_mappings": {
      "gam": {
        "network_code": "yahoo_network_123",
        "advertiser_id": "nike_advertiser_456"
      }
    }
  },
  "brief": "Premium sports placements for new shoe launch"
}
```

3. **Yahoo's Catalog Response**:
- Verifies Nike has a GAM account on their network
- Returns products with implementation_config
- Applies any Nike-specific pricing

4. **Media Buy Creation**:
- Nike selects `yahoo_sports_premium`
- Adapter uses Nike's `advertiser_id` + product's `implementation_config`
- Creates line items in Yahoo's GAM with proper targeting

### Discovery to Purchase Flow

```
1. list_products → Find relevant inventory with principal context
2. get_avails → Check availability and pricing
3. create_media_buy → Purchase using implementation_config
4. add_creative_assets → Upload creatives
5. Monitor delivery → Track performance
```

The pluggable catalog system ensures publishers maintain control over their inventory while enabling intelligent, brief-based discovery for advertisers.
