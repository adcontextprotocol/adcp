---
name: adcp-media-buy
description: Execute AdCP Media Buy Protocol operations with sales agents - discover advertising products, create and manage campaigns, sync creatives, and track delivery. Use when users want to buy advertising, create media buys, interact with ad sales agents, or test advertising APIs.
---

# AdCP Media Buy Protocol

This skill enables you to execute the AdCP Media Buy Protocol with sales agents. Use the standard MCP tools (`get_products`, `create_media_buy`, `sync_creatives`, etc.) exposed by the connected agent.

> **Buyer-side basics** — idempotency replay, `oneOf` variants, async `status:'submitted'` polling, error recovery from `adcp_error.issues[]` — live in `skills/call-adcp-agent/SKILL.md`. This skill covers per-task semantics only.

## Overview

The Media Buy Protocol provides 11 standardized tasks for managing advertising campaigns:

| Task | Purpose | Response Time |
|------|---------|---------------|
| `get_products` | Discover inventory using natural language | ~60s |
| `get_adcp_capabilities` | See agent capabilities, supported protocols, and publisher properties | ~1s |
| `create_media_buy` | Create campaigns | Minutes-Days |
| `update_media_buy` | Modify campaigns | Minutes-Days |
| `get_media_buys` | Retrieve campaign state and status | ~1-5s |
| `sync_creatives` | Upload creative assets | Minutes-Days |
| `sync_catalogs` | Sync product feeds and catalogs | Minutes-Days |
| `list_creatives` | Query creative library | ~1s |
| `get_media_buy_delivery` | Get performance data | ~60s |
| `provide_performance_feedback` | Share outcomes with publishers | ~1-5s |

## Typical Workflow

1. **Discover products**: `get_products` with a natural language brief
2. **Review formats**: read each returned product's canonical `format_options[]`
3. **Create campaign**: `create_media_buy` with selected products and budget
4. **Upload creatives**: `sync_creatives` to add creative assets
5. **Monitor delivery**: `get_media_buy_delivery` to track performance

---

## Canonical formats (AdCP 3.2)

Products carry `format_options[]`: a list of `ProductFormatDeclaration` entries describing the creative shapes the product accepts. Each declaration carries:

- `format_kind` — one of the 12 canonicals: `image`, `html5`, `display_tag`, `image_carousel`, `video_hosted`, `video_vast`, `audio_hosted`, `audio_daast`, `sponsored_placement`, `native_in_feed`, `responsive_creative`, or `agent_placement`; use `custom` only with `format_shape` and `format_schema`
- `params` — per-canonical parameters narrowing the format (dimensions, durations, codecs, char limits, CTA enums)
- Optional `format_option_id` — disambiguates product options and identifies publisher-catalog declarations when paired with `publisher_domain`
- Optional `v1_format_ref: [{agent_url, id}]` — array linking this v2 declaration to one or more v1 named formats (for dual emission during the v1↔v2 migration). Multi-size declarations should carry one ref per size
- Optional `seller_preference: "preferred" | "accepted" | "discouraged"` — soft routing hint when a multi-format product has several options at the same price

**Multi-format products.** A flexible publisher slot is one product with N format_options entries — e.g., NYTimes Homepage accepts image OR html5 OR display_tag at multiple sizes via three format_options, one per type. Buyer picks the creative type they ship.

**Size flexibility.** Display canonicals (image / html5 / display_tag) declare size in one of three modes: fixed (`width`+`height`), multi-size (`sizes: [{w,h}]` — mirrors OpenRTB `banner.format[]`), or responsive (`min_width`/`max_width`/`min_height`/`max_height`). Modes are mutually exclusive.

**Discovering publisher catalogs.** Call `GET https://agenticadvertising.org/api/registry/publisher?domain=<publisher_domain>` for publisher-origin → AgenticAdvertising.org community-catalog → fail-closed resolution and provenance. Add `&include=placements` for provenance-labeled placement summaries with resolved canonical format options. The lookup's top-level `formats[]` remains a lossy display summary; fetch the returned raw registry or hosting URL when you need custom schema fields or other omitted declaration fields. Do not infer publisher authority from a seller's product catalog. Seller-specific deliverability comes from that seller's `Product.format_options[]`.

**Conversion tracking lives elsewhere.** Pixel-firing, conversion events, and attribution belong on `sync_event_sources` / `event_log` (campaign-scoped), NOT on creative format declarations. Sending `pixel_id` in `platform_extensions` on a format is a category error.

**Error codes specific to canonical formats.** `FORMAT_PROJECTION_FAILED`, `FORMAT_DECLARATION_DIVERGENT`, `FORMAT_DECLARATION_V1_AMBIGUOUS`, `FORMAT_CAPABILITY_UNRESOLVED`, `FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE` — all non-fatal advisories surfaced via the response `errors[]` array. See `static/schemas/source/enums/error-code.json` for full recovery semantics.

See `docs/creative/canonical-formats.mdx` for the full vocabulary, narrowing rules, and worked examples.

---

## Task Reference

### get_products

Discover advertising products using natural language briefs.

**Request:**
```json
{
  "buying_mode": "brief",
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
- `buying_mode` (string): Required discriminator - `"brief"` or `"wholesale"`
- `brief` (string): Natural language description of campaign requirements
- `brand` (object): Brand identity - `{ "domain": "acmecorp.com" }`
- `filters` (object, optional): Filter by channels, budget, delivery_type

**Response contains:**
- `products`: Array of matching products with `product_id`, `name`, `description`, `pricing_options`
- Each product includes canonical `format_options[]` and targeting capabilities

---

### create_media_buy

Create an advertising campaign from selected products.

**Request:**
```json
{
  "brand": {
    "domain": "acme.com"
  },
  "packages": [
    {
      "product_id": "premium_video_30s",
      "pricing_option_id": "cpm-standard",
      "budget": 10000
    }
  ],
  "start_time": "asap",
  "end_time": "2024-03-31T23:59:59Z"
}
```

**Key fields:**
- `brand` (object, required): Brand identity - `{ "domain": "acmecorp.com" }`
- `packages` (array, required): Products to purchase, each with:
  - `product_id`: From `get_products` response
  - `pricing_option_id`: From product's `pricing_options`
  - `budget`: Amount in dollars
  - `bid_price`: Required for auction pricing
  - `targeting_overlay`: Additional targeting constraints
  - `creative_ids` or `creatives`: Creative assignments
- `start_time` (string, required): `"asap"` or an ISO 8601 datetime (e.g., `"2024-06-01T00:00:00Z"`)
- `end_time` (string, required): ISO 8601 datetime

**Response contains:**
- `media_buy_id`: The created campaign identifier
- `status`: Current lifecycle state — `pending_creatives` (no creatives assigned yet), `pending_start` (waiting for flight date), or `active` (serving immediately)
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

### sync_catalogs

Sync product catalogs, store locations, job postings, and other structured feeds to a seller account. Supports inline items or external feed URLs. When called without catalogs, returns existing catalogs (discovery mode).

**Request:**
```json
{
  "account": {
    "account_id": "acct_123"
  },
  "catalogs": [
    {
      "catalog_id": "winter-collection",
      "name": "Winter 2025 Collection",
      "type": "product",
      "items": [
        { "id": "sku-001", "name": "Wool Coat", "price": 299.99, "currency": "USD" }
      ]
    }
  ]
}
```

**Key fields:**
- `account` (object, required): Account that owns the catalogs — `{ account_id }`
- `catalogs` (array, optional): Catalog objects to sync. Omit for discovery mode.
  - `type` (string, required): `offering`, `product`, `inventory`, `store`, `promotion`, `hotel`, `flight`, `job`, `vehicle`, `real_estate`, `education`, `destination`, `app`
  - `items` (array): Inline catalog data (mutually exclusive with `url`)
  - `url` (string): External feed URL (mutually exclusive with `items`)
  - `feed_format` (string): `google_merchant_center`, `facebook_catalog`, `shopify`, `linkedin_jobs`, `custom`
- `delete_missing` (boolean, optional): Remove catalogs not in this sync (use with caution)
- `dry_run` (boolean, optional): Preview changes without applying

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
      "format_kind": "video_hosted",
      "format_option_ref": {
        "scope": "product",
        "format_option_id": "video_30s"
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
  - `format_kind`: Canonical format accepted by the selected product
  - `format_option_ref`: Product or publisher option when `format_kind` alone is ambiguous
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
    "status": ["active"]
  },
  "limit": 20
}
```

---

### get_media_buys

Retrieve media buy state: status, valid_actions, creative approvals, pending formats, and optional delivery snapshots or revision history.

**Request:**
```json
{
  "media_buy_ids": ["mb_abc123"],
  "include_snapshot": true,
  "include_history": 5
}
```

**Key fields:**
- `media_buy_ids` (array, optional): Specific media buy IDs to retrieve
- `account` (object, optional): Filter to a specific account
- `status_filter` (string or array, optional): Filter by status — `pending_creatives`, `pending_start`, `active`, `paused`, `completed`, `rejected`, `canceled`. Defaults to `["active"]` when no IDs provided.
- `include_snapshot` (boolean, optional): Include near-real-time delivery snapshots per package
- `include_history` (integer, optional): Include the last N revision history entries per media buy

**Response contains:**
- `media_buys`: Array with `media_buy_id`, `status`, `valid_actions`, `packages`, creative approval state
- Optional `snapshot` per package (impressions, spend, pacing)
- Optional `history` entries (revision, timestamp, actor, action, summary)

#### Relationship-scoped insights

Before querying insights, read `get_adcp_capabilities.media_buy.supported_insight_types`. Insights may appear at three levels:

- buy: `get_media_buys.media_buys[]` (`budget_constrained`)
- package: `packages[]` (`creative_diversity_low`, `audience_saturation`, `inventory_shortfall_forecast`, `pacing_risk`, `budget_constrained`)
- assignment: `creative_approvals[]` and the matching `list_creatives.assignments.assigned_packages[]` (`creative_fatigue`, `creative_quality_opportunity`)

`insights` omitted means unknown. A present array requires `insight_types_evaluated` and `insights_as_of`; empty means clear only for those named types and coverage. `scope` narrows an assertion; `insights_evaluated_scope` declares partial publisher/placement coverage. Creative-library sellers advertise `list_creatives` in `insight_notifications.repair_tasks`; those sellers include `media_buy_id`, approval state, and any `approval_scopes` on every reverse assignment row. Inline-only sellers repair through `get_media_buys` alone.

For portfolio discovery, call `list_creatives` with `filters.insight_types`, `include_assignments: true`, `assignment_projection: "matching"`, a bounded `assignment_limit`, sparse `fields: ["creative_id", "assignments"]`, and cursor pagination. Check `assignments_truncated`; use `get_media_buys` for complete repair. Key evaluated state by seller + `media_buy_id` + `package_id` + `creative_id` + type + normalized placement scope.

Never clear from filtered disappearance or failure. Reread directly without `insight_types`; clear only a named evaluated type in covered scope from a strictly newer snapshot. Equal-timestamp conflicts are no-ops. Direct assignment deletion retires its keys.

All insight-capable sellers accept `insights.changed`; creative-library sellers may additionally declare `creative.assignment_changed` with `list_creatives` repair. Subscriptions are prospective, so perform an unfiltered baseline read after activation. Verify, dedupe, and reread; webhook payloads are invalidations, not state. Timestamp-only reevaluation does not fire, while material in-place creative updates invalidate prior assignment evaluations. Root `warnings[]` on successful create/update are immediate receipts; inventory and pacing warning codes require the matching advertised durable insight type.

---

### provide_performance_feedback

Share performance outcomes with publishers to enable data-driven optimization.

**Request:**
```json
{
  "media_buy_id": "mb_abc123",
  "measurement_period": {
    "start": "2025-01-01T00:00:00Z",
    "end": "2025-01-31T23:59:59Z"
  },
  "performance_index": 1.2,
  "metric_type": "conversion_rate",
  "feedback_source": "buyer_attribution"
}
```

**Key fields:**
- `media_buy_id` (string, required): Publisher's media buy identifier
- `measurement_period` (object, required): Time period with `start` and `end` (ISO 8601)
- `performance_index` (number, required): Normalized score — 0.0 = no value, 1.0 = expected, >1.0 = above expected
- `package_id` (string, optional): Specific package for package-level feedback
- `creative_id` (string, optional): Specific creative for creative-level feedback
- `metric_type` (string, optional): `overall_performance`, `conversion_rate`, `brand_lift`, `click_through_rate`, `completion_rate`, `viewability`, `brand_safety`, `cost_efficiency`
- `feedback_source` (string, optional): `buyer_attribution`, `third_party_measurement`, `platform_analytics`, `verification_partner`

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

### Canonical format options

Products declare their closed accepted set directly:
```json
{
  "format_option_id": "display_image_300x250",
  "format_kind": "image",
  "params": { "width": 300, "height": 250 }
}
```

Buyers select the option with `format_option_refs[]` on the package and submit a manifest using `format_kind` plus `format_option_ref`. Compound named format IDs are deprecated in 3.2.

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

Use **sandbox mode** for testing without real transactions. Sandbox is account-level — once a request references a sandbox account, the entire request is treated as sandbox with no real platform calls or spend.

Check whether the agent supports sandbox via `get_adcp_capabilities`:
```json
{
  "account": {
    "sandbox": true
  }
}
```

To enter sandbox mode, set `sandbox: true` on the account reference:
```json
{
  "account": {
    "brand": { "domain": "acme-corp.com" },
    "operator": "acme-corp.com",
    "sandbox": true
  }
}
```

Some sync tasks (`sync_creatives`, `sync_catalogs`) also support a `dry_run` parameter that previews changes without applying them. This is orthogonal to sandbox — you can use `dry_run` in both sandbox and production accounts.

See [Sandbox mode](https://docs.adcontextprotocol.org/docs/media-buy/advanced-topics/sandbox) for full details.
