---
name: adcp-creative
description: Execute AdCP Creative Protocol operations with creative agents - build creatives from briefs or existing assets, preview renderings, and discover format specifications. Use when users want to generate or transform ad creatives, preview how ads will look, or understand creative format requirements.
---

# AdCP Creative Protocol

This skill enables you to execute the AdCP Creative Protocol with creative agents. Use `get_adcp_capabilities`, `list_transformers`, `build_creative`, and `preview_creative` exposed by the connected agent. In AdCP 3.2, `list_creative_formats` is deprecated and must not drive a new workflow.

> **Buyer-side basics** — idempotency replay, `oneOf` variants, async `status:'submitted'` polling, error recovery from `adcp_error.issues[]` — live in `skills/call-adcp-agent/SKILL.md`. This skill covers per-task semantics only.

## Overview

The Creative Protocol provides standardized discovery, build, and preview tasks:

| Task | Purpose | Response Time |
|------|---------|---------------|
| `get_adcp_capabilities` | Discover canonical creative capabilities | ~1s |
| `list_transformers` | Discover selectable production services | ~1s |
| `build_creative` | Generate or transform creatives | ~30s-5m |
| `preview_creative` | Get visual previews | ~5s |
| `get_creative_delivery` | Variant-level delivery data | ~5-30s |

## Typical Workflow

1. **Discover capabilities**: read `get_adcp_capabilities.creative.supported_formats[]`
2. **Build creative**: `build_creative` to generate or transform a manifest
3. **Preview**: `preview_creative` to see how it renders
4. **Sync**: Use `sync_creatives` (media-buy task) to traffic the creative

---

## Canonical formats (AdCP 3.2)

Products and manifests use 12 canonical `format_kind` values: `image`, `html5`, `display_tag`, `image_carousel`, `video_hosted`, `video_vast`, `audio_hosted`, `audio_daast`, `sponsored_placement`, `native_in_feed`, `responsive_creative`, and `agent_placement`. Use `custom` only for a shape outside those canonicals, with required `format_shape` and `format_schema`.

A `ProductFormatDeclaration` carries:

- `format_kind`: the canonical (discriminator)
- `params`: per-canonical parameters narrowing the format (dimensions, durations, codecs, char limits, CTA enums, sizes[], etc.)
- Optional `format_option_id`: stable product/publisher option identifier when declarations need routing
- Optional `v1_format_ref: [{agent_url, id}]`: **always an array** — links this v2 declaration to one or more v1 named formats. Multi-size declarations should carry one ref per size in `sizes[]`.
- Optional `seller_preference: "preferred" | "accepted" | "discouraged"`: soft routing hint when a product carries multiple format_options

**Where to declare a format:**

| Where | When to use |
|---|---|
| `adagents.json` top-level `formats[]` (publisher catalog) | Format shared across many sellers of the same publisher inventory; declares the publisher-authoritative shape once |
| `Product.format_options[]` (inline on a product) | Seller-specific accepted set. Reference a publisher declaration with `{publisher_domain, format_option_id}` when applicable |
| `Placement.format_options[]` (`format_option_id` reference or inline) | Tying a publisher placement to accepted publisher formats |
| `get_adcp_capabilities.creative.supported_formats[]` | What a creative agent can build, validate, or preview; every entry has an agent-local `capability_id` |

**Size flexibility (image / html5 / display_tag):** exactly one of three modes — `width`+`height` (fixed), `sizes: [{w,h}]` (multi-size, mirrors OpenRTB `banner.format[]`), or `min_width`/`max_width`/`min_height`/`max_height` (responsive).

**Publisher catalog resolution:** call `GET https://agenticadvertising.org/api/registry/publisher?domain=<publisher_domain>` for the complete publisher-origin → AgenticAdvertising.org community-catalog → fail-closed resolution order and provenance. Add `&include=placements` for provenance-labeled placement summaries with resolved canonical format options. The top-level `formats[]` remains a lossy display summary; fetch the raw URL returned in `files.adagents_json.registry_url` or `hosting.resolved_url` / `hosting.expected_url` for custom-format validation and omitted declaration fields. Do not synthesize publisher authority from a sales or creative agent.

**Conversion tracking is NOT a creative-format concern.** Pixel-firing, conversion events, and attribution belong on `sync_event_sources` / `event_log` (campaign-scoped). Don't stuff `pixel_id` into `platform_extensions` on a format declaration.

See `docs/creative/canonical-formats.mdx` for the full vocabulary, narrowing rules, error-code surface, and worked examples (Meta Reels, IAB display, host-read podcast, generative DSP).

---

## Task Reference

### get_adcp_capabilities

Discover this creative agent's canonical operations.

**Request:**
```json
{ "protocols": ["creative"] }
```

**Response contains:**
- `creative.supported_formats[]`: entries with stable, catalog-unique `capability_id`, canonical `format`, and `operations`; preview support is declared by `operations` containing `preview`
- capability flags such as `supports_generation` and `supports_transformers`

---

### build_creative

Generate a creative from scratch or transform an existing creative to a different format.

**Pure Generation (from brief):**
```json
{
  "message": "Create a banner promoting our winter sale with a warm, inviting feel",
  "target_capability_id": "winter_banner_300x250",
  "idempotency_key": "1db179c8-09c8-4eb3-9b96-ae741acdaf1f",
  "brand": {
    "domain": "mybrand.com"
  }
}
```

**Transformation (resize/reformat):**
```json
{
  "message": "Adapt this leaderboard to a 300x250 banner",
  "creative_manifest": {
    "format_kind": "image",
    "assets": {
      "image_main": {
        "asset_type": "image",
        "url": "https://cdn.mybrand.com/leaderboard.png",
        "width": 728,
        "height": 90
      },
      "landing_page_url": {
        "asset_type": "url",
        "url": "https://mybrand.com/spring-sale"
      }
    }
  },
  "target_capability_id": "banner_resize_300x250",
  "idempotency_key": "4c052b08-2e5f-4a66-b0c0-57c199302411"
}
```

**Key fields:**
- `message` (string, optional): Natural language instructions for generation/transformation
- `creative_manifest` (object, optional): Source manifest - minimal for generation, complete for transformation
- `target_capability_id` (string): One output advertised by this agent; use `target_capability_ids[]` for multiple outputs

**Response contains:**
- `creative_manifest`: Complete manifest ready for `preview_creative` or `sync_creatives`

---

### preview_creative

Generate visual previews of creative manifests.

**Single preview:**
```json
{
  "request_type": "single",
  "creative_manifest": {
    "format_kind": "image",
    "assets": {
      "image_main": {
        "asset_type": "image",
        "url": "https://cdn.example.com/banner.png",
        "width": 300,
        "height": 250
      }
    }
  }
}
```

**With device variants:**
```json
{
  "request_type": "single",
  "creative_manifest": { /* includes format_kind, assets */ },
  "inputs": [
    { "name": "Desktop", "macros": { "DEVICE_TYPE": "desktop" } },
    { "name": "Mobile", "macros": { "DEVICE_TYPE": "mobile" } }
  ]
}
```

**Batch preview (5-10x faster):**
```json
{
  "request_type": "batch",
  "requests": [
    { "creative_manifest": { /* creative 1 */ } },
    { "creative_manifest": { /* creative 2 */ } }
  ]
}
```

**Key fields:**
- `request_type` (string, required): `"single"` or `"batch"`
- `creative_manifest` (object, required): Complete creative manifest
- `inputs` (array, optional): Generate variants with different macros/contexts
- `output_format` (string, optional): `"url"` (default) or `"html"`

**Response contains:**
- `previews`: Array of preview objects with `preview_url` or `preview_html`
- `expires_at`: When preview URLs expire

---

### get_creative_delivery

Retrieve variant-level creative delivery data from a creative agent. Returns what was generated, served, and how each variant performed.

**Request:**
```json
{
  "media_buy_ids": ["mb_abc123"],
  "start_date": "2025-01-01",
  "end_date": "2025-01-31",
  "max_variants": 10
}
```

**Key fields:**
- `media_buy_ids` (array, optional): Filter to specific media buys
- `creative_ids` (array, optional): Filter to specific creatives
- `start_date`, `end_date` (string, optional): Delivery period (YYYY-MM-DD)
- `max_variants` (integer, optional): Max variants per creative (useful for generative creatives)
- `account` (object, optional): Account for routing and scoping

At least one scoping filter (`media_buy_ids` or `creative_ids`) is required.

**Response contains:**
- `creatives`: Array with variant-level delivery data
  - `variant_id`: Unique variant identifier (use in `preview_creative` with `request_type: "variant"`)
  - `generation_context`: What triggered this variant (page topic, device, etc.)
  - `delivery_metrics`: Impressions, clicks, completions
  - `ext`: Platform engagement metrics (likes, shares, comments)

---

## Key Concepts

### Capability IDs and canonical manifests

A creative agent's `capability_id` is a local operation selector:
```json
{
  "target_capability_id": "winter_banner_300x250"
}
```

It is never copied into a product or manifest. The resulting manifest is portable and carries the canonical format contract:

### Creative Manifests

Manifests pair format specifications with actual assets:
```json
{
  "format_kind": "image",
  "assets": {
    "banner_image": {
      "asset_type": "image",
      "url": "https://cdn.example.com/banner.png",
      "width": 300,
      "height": 250
    },
    "headline": {
      "asset_type": "text",
      "content": "Shop Now"
    },
    "clickthrough_url": {
      "asset_type": "url",
      "url": "https://brand.com/sale"
    }
  }
}
```

### Asset Types

Common asset types:
- `image`: Static images (JPEG, PNG, WebP)
- `video`: Video files (MP4, WebM) or VAST tags
- `audio`: Audio files (MP3, M4A) or DAAST tags
- `text`: Headlines, descriptions, CTAs
- `html`: HTML5 creatives or third-party tags
- `javascript`: JavaScript tags
- `url`: Tracking pixels, clickthrough URLs

### Brand identity

For generative creatives, provide brand context by domain:
```json
{
  "brand": {
    "domain": "acmecorp.com"
  }
}
```

The agent resolves the domain to retrieve the brand's identity (name, colors, guidelines, etc.) from its `brand.json` file.

### Generative vs Transformation

- **Pure Generation**: Provide `target_capability_id`, `brand`, and a natural language `message`. The creative agent generates all output assets from scratch.
- **Transformation**: Complete manifest with existing assets. Creative agent adapts to target format, following `message` guidance.

---

## Error Handling

Common error patterns:

- **400 Bad Request**: Invalid manifest or capability selector
- **404 Not Found**: Capability not supported by this agent
- **422 Validation Error**: Manifest doesn't match format requirements

Error responses include:
```json
{
  "error": {
    "code": "FORMAT_NOT_SUPPORTED",
    "message": "target_capability_id is not advertised by this creative agent"
  }
}
```
