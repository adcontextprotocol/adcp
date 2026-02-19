---
name: adcp-media-buy
description: Execute AdCP Media Buy Protocol operations with sales agents - discover advertising products, create and manage campaigns, sync creatives, and track delivery. Use when users want to buy advertising, create media buys, interact with ad sales agents, or test advertising APIs.
---

# AdCP Media Buy Protocol

This skill enables you to execute the AdCP Media Buy Protocol with sales agents. Use the standard MCP tools (`get_products`, `create_media_buy`, `sync_creatives`, etc.) exposed by the connected agent.

## Overview

The Media Buy Protocol provides 8 standardized tasks for managing advertising campaigns:

| Task | Purpose | Response Time |
|------|---------|---------------|
| `get_products` | Discover inventory using natural language | ~60s |
| `list_authorized_properties` | See publisher properties | ~1s |
| `list_creative_formats` | View creative specifications | ~1s |
| `create_media_buy` | Create campaigns | Minutes-Days |
| `update_media_buy` | Modify campaigns | Minutes-Days |
| `sync_creatives` | Upload creative assets | Minutes-Days |
| `list_creatives` | Query creative library | ~1s |
| `get_media_buy_delivery` | Get performance data | ~60s |

## Typical Workflow

1. **Discover products**: `get_products` with a natural language brief
2. **Review formats**: `list_creative_formats` to understand creative requirements
3. **Create campaign**: `create_media_buy` with selected products and budget
4. **Upload creatives**: `sync_creatives` to add creative assets
5. **Monitor delivery**: `get_media_buy_delivery` to track performance

---

## Task Reference

### get_products

Discover advertising products using natural language briefs.

**Request:**
```json
{
  "brief": "Looking for premium video inventory for a tech brand targeting developers",
  "brand": {
    "domain": "example.com"
  },
  "filters": {
    "channels": ["video", "ctv"],
    "budget_range": { "min": 5000, "max": 50000 }
  }
}
```

**Key fields:**
- `brief` (string): Natural language description of campaign requirements
- `brand` (object): Brand identity - `{ "domain": "acmecorp.com" }`
- `filters` (object, optional): Filter by channels, budget, delivery_type, format_types

**Response contains:**
- `products`: Array of matching products with `product_id`, `name`, `description`, `pricing_options`
- Each product includes `format_ids` (supported creative formats) and `targeting` (available targeting)

---

### list_authorized_properties

Get the list of publisher properties this agent can sell.

**Request:**
```json
{}
```

No parameters required.

**Response contains:**
- `publisher_domains`: Array of domain strings the agent is authorized to sell

---

### list_creative_formats

View supported creative specifications.

**Request:**
```json
{
  "format_types": ["video", "display"]
}
```

**Key fields:**
- `format_types` (array, optional): Filter to specific format categories

**Response contains:**
- `formats`: Array of format specifications with dimensions, requirements, and asset schemas

---

### create_media_buy

Create an advertising campaign from selected products.

**Request:**
```json
{
  "buyer_ref": "campaign-2024-q1-001",
  "brand": {
    "domain": "acme.com"
  },
  "packages": [
    {
      "buyer_ref": "pkg-video-001",
      "product_id": "premium_video_30s",
      "pricing_option_id": "cpm-standard",
      "budget": 10000
    }
  ],
  "start_time": {
    "type": "asap"
  },
  "end_time": "2024-03-31T23:59:59Z"
}
```

**Key fields:**
- `buyer_ref` (string, required): Your unique identifier for this campaign
- `brand` (object, required): Brand identity - `{ "domain": "acmecorp.com" }`
- `packages` (array, required): Products to purchase, each with:
  - `buyer_ref`: Your identifier for this package
  - `product_id`: From `get_products` response
  - `pricing_option_id`: From product's `pricing_options`
  - `budget`: Amount in dollars
  - `bid_price`: Required for auction pricing
  - `targeting_overlay`: Additional targeting constraints
  - `creative_ids` or `creatives`: Creative assignments
- `start_time` (object, required): `{ "type": "asap" }` or `{ "type": "scheduled", "datetime": "..." }`
- `end_time` (string, required): ISO 8601 datetime

**Response contains:**
- `media_buy_id`: The created campaign identifier
- `status`: Current state (often `pending` for async approval)
- `packages`: Created packages with their IDs

---

### update_media_buy

Modify an existing campaign.

**Request:**
```json
{
  "media_buy_id": "mb_abc123",
  "updates": {
    "budget_change": 5000,
    "end_time": "2024-04-30T23:59:59Z",
    "status": "paused"
  }
}
```

**Key fields:**
- `media_buy_id` (string, required): The campaign to update
- `updates` (object): Changes to apply - budget_change, end_time, status, targeting, etc.

---

### sync_creatives

Upload and manage creative assets.

**Request:**
```json
{
  "creatives": [
    {
      "creative_id": "hero_video_30s",
      "name": "Brand Hero Video",
      "format_id": {
        "agent_url": "https://creative.adcontextprotocol.org",
        "id": "video_standard_30s"
      },
      "assets": {
        "video": {
          "url": "https://cdn.example.com/hero.mp4",
          "width": 1920,
          "height": 1080,
          "duration_ms": 30000
        }
      }
    }
  ],
  "assignments": {
    "hero_video_30s": ["pkg_001", "pkg_002"]
  }
}
```

**Key fields:**
- `creatives` (array, required): Creative assets to sync
  - `creative_id`: Your unique identifier
  - `format_id`: Object with `agent_url` and `id` from format specifications
  - `assets`: Asset content (video, image, html, etc.)
- `assignments` (object, optional): Map creative_id to package IDs
- `dry_run` (boolean): Preview changes without applying
- `delete_missing` (boolean): Archive creatives not in this sync

---

### list_creatives

Query the creative library with filtering.

**Request:**
```json
{
  "filters": {
    "status": ["active"],
    "format_types": ["video"]
  },
  "limit": 20
}
```

---

### get_media_buy_delivery

Retrieve performance metrics for a campaign.

**Request:**
```json
{
  "media_buy_id": "mb_abc123",
  "granularity": "daily",
  "date_range": {
    "start": "2024-01-01",
    "end": "2024-01-31"
  }
}
```

**Response contains:**
- `delivery`: Aggregated metrics (impressions, spend, clicks, etc.)
- `by_package`: Breakdown by package
- `timeseries`: Data points over time if granularity specified

---

## Key Concepts

### Brand identity

Brand context is provided by domain reference:

```json
{
  "brand": {
    "domain": "acmecorp.com"
  }
}
```

The agent resolves the domain to retrieve the brand's identity (name, colors, guidelines, etc.) from its `brand.json` file.

### Format IDs

Creative format identifiers are structured objects:
```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "display_300x250"
  }
}
```

The `agent_url` specifies which creative agent defines the format. Use `https://creative.adcontextprotocol.org` for standard IAB formats.

### Pricing Options

Products include `pricing_options` array. Each option has:
- `pricing_option_id`: Use this in `create_media_buy`
- `pricing_model`: "cpm", "cpm-auction", "flat-fee", etc.
- `price`: Base price (for fixed pricing)
- `floor`: Minimum bid (for auction)

For auction pricing, include `bid_price` in your package.

### Asynchronous Operations

Operations like `create_media_buy` and `sync_creatives` may require human approval. The response includes:
- `status: "pending"` - Operation awaiting approval
- `task_id` - For tracking async progress

Poll or use webhooks to check completion status.

---

## Error Handling

Common error patterns:

- **400 Bad Request**: Invalid parameters - check required fields
- **401 Unauthorized**: Invalid or missing authentication token
- **404 Not Found**: Invalid product_id, media_buy_id, or creative_id
- **422 Validation Error**: Schema validation failure - check field types

Error responses include:
```json
{
  "errors": [
    {
      "code": "VALIDATION_ERROR",
      "message": "budget must be greater than 0",
      "field": "packages[0].budget"
    }
  ]
}
```

---

## Testing Mode

For testing without real transactions, agents may support:
- `X-Dry-Run: true` header - Preview without side effects
- Test products with `test: true` flag
- Sandbox environments

Ask the agent about testing capabilities before creating real campaigns.
