---
title: Media Products & Discovery
---

# Media Products & Discovery

A **Product** is the core sellable unit in AdCP. This document details the Product model, including its pricing and delivery types, and the process for discovering standard, principal-specific, and custom-generated products.

## The Product Model

- `product_id` (string, required)
- `name` (string, required)
- `description` (string, required)
- `formats` (list[Format], required): See [Creative Formats](creative-formats.md).
- `implementation_config` (JSON, required): Ad server-specific configuration for creating the media buy.
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

## Product Discovery Lifecycle

The product discovery process in AdCP is designed to be intuitive and AI-friendly, allowing buyers to find relevant inventory using natural language. Here's how it works:

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

Alternatively, buyers can browse the full product catalog with filters:

```json
{
  "category": "video",
  "min_budget": 5000,
  "formats": ["video"]
}
```

This returns all matching products available to the principal, including:
- Standard catalog products
- Principal-specific negotiated rates
- Custom products created for previous campaigns

### 4. Custom Product Generation

For unique requirements, the system can generate custom products on-demand:

1. **Brief Analysis**: The AI analyzes requirements that don't match existing products
2. **Custom Creation**: New products are created with `is_custom: true`
3. **Expiration**: Custom products include `expires_at` to prevent catalog bloat
4. **Pricing**: Custom pricing based on the specific requirements

### Discovery Best Practices

1. **Start Broad**: Begin with natural language discovery to understand options
2. **Refine Requirements**: Use discovery insights to refine targeting and budget
3. **Check Availability**: Move to `get_avails` once products are identified
4. **Consider Custom**: For unique campaigns, leverage custom product generation

### Discovery to Purchase Flow

```
1. discover_products → Find relevant inventory
2. get_avails → Check availability and pricing
3. create_media_buy → Purchase selected products
4. add_creative_assets → Upload creatives
5. Monitor delivery → Track performance
```

The discovery process is designed to feel conversational while providing structured data for programmatic execution.
