---
title: Brand Card
description: Standardized brand information manifest for creative generation and media buying
keywords: [brand card, brand manifest, creative generation, brand guidelines]
---

# Brand Card

The **Brand Card** is a standardized manifest format for sharing brand information across AdCP workflows. It enables low-friction creative generation by providing brand context that can be easily cached and reused across multiple requests.

## Overview

Brand cards solve a key problem identified in creative agent workflows: how to efficiently provide brand context without requiring complex authorization flows or repeated data entry. The format supports both simple use cases (just a URL) and enterprise scenarios (comprehensive brand assets and guidelines).

### Key Benefits

- **Minimal Friction**: Start with just a URL, expand as needed
- **Cacheable**: Same brand card can be reused across requests
- **Standardized**: Consistent format across all AdCP implementations
- **Flexible**: Supports SMB to enterprise use cases
- **AI-Optimized**: Structured for easy ingestion by creative agents

## Use Cases

### SMB / Ad Hoc Creative Generation

For small businesses or one-off campaigns, a minimal brand card provides enough context:

```json
{
  "url": "https://bobsfunburgers.com"
}
```

Creative agents can infer brand information from the URL, pulling logos, colors, and style from the website.

### Enterprise / Established Brand

For established brands with defined guidelines, the brand card provides comprehensive context:

```json
{
  "url": "https://acmecorp.com",
  "name": "ACME Corporation",
  "logos": [
    {
      "url": "https://cdn.acmecorp.com/logo-square-dark.png",
      "tags": ["dark", "square"],
      "width": 512,
      "height": 512
    },
    {
      "url": "https://cdn.acmecorp.com/logo-horizontal-light.png",
      "tags": ["light", "horizontal"],
      "width": 1200,
      "height": 400
    }
  ],
  "colors": {
    "primary": "#FF6B35",
    "secondary": "#004E89",
    "accent": "#F7931E",
    "background": "#FFFFFF",
    "text": "#1A1A1A"
  },
  "fonts": {
    "primary": "Helvetica Neue",
    "secondary": "Georgia"
  },
  "tone": "professional and trustworthy",
  "tagline": "Innovation You Can Trust",
  "product_feed": "https://acmecorp.com/products.rss",
  "industry": "technology",
  "target_audience": "business decision-makers aged 35-55"
}
```

### Multi-SKU Retailer

Large retailers can provide product feeds and asset libraries:

```json
{
  "url": "https://bigretail.com",
  "name": "BigRetail",
  "product_feed": "https://bigretail.com/catalog.json",
  "asset_library": {
    "images": "https://assets.bigretail.com/api/images",
    "videos": "https://assets.bigretail.com/api/videos"
  },
  "disclaimers": [
    {
      "text": "Prices and availability subject to change",
      "context": "pricing",
      "required": true
    }
  ]
}
```

## Brand Card Schema

**Schema URL**: [/schemas/v1/core/brand-card.json](/schemas/v1/core/brand-card.json)

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `url` | string (uri) | Primary brand URL for context and asset discovery |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Brand or business name |
| `logos` | Logo[] | Brand logo assets with semantic tags |
| `colors` | Colors | Brand color palette (hex format) |
| `fonts` | Fonts | Brand typography guidelines |
| `tone` | string | Brand voice and messaging tone |
| `tagline` | string | Brand tagline or slogan |
| `product_feed` | string (uri) | URL to product catalog feed |
| `asset_library` | AssetLibrary | References to brand asset libraries |
| `disclaimers` | Disclaimer[] | Legal disclaimers for creatives |
| `industry` | string | Industry or vertical |
| `target_audience` | string | Primary target audience description |
| `contact` | Contact | Brand contact information |
| `metadata` | Metadata | Version and update tracking |

### Logo Object

```typescript
{
  url: string;           // URL to logo asset
  tags?: string[];       // Semantic tags (e.g., "dark", "light", "square", "horizontal")
  width?: number;        // Logo width in pixels
  height?: number;       // Logo height in pixels
}
```

**Common Tags**: `"dark"`, `"light"`, `"square"`, `"horizontal"`, `"vertical"`, `"icon"`, `"wordmark"`, `"lockup"`

### Colors Object

```typescript
{
  primary?: string;      // Primary brand color (#RRGGBB)
  secondary?: string;    // Secondary brand color (#RRGGBB)
  accent?: string;       // Accent color (#RRGGBB)
  background?: string;   // Background color (#RRGGBB)
  text?: string;         // Text color (#RRGGBB)
}
```

### Fonts Object

```typescript
{
  primary?: string;      // Primary font family name
  secondary?: string;    // Secondary font family name
  font_urls?: string[];  // URLs to web font files
}
```

### Disclaimer Object

```typescript
{
  text: string;          // Disclaimer text
  context?: string;      // When this applies (e.g., "financial_products", "health_claims")
  required?: boolean;    // Whether this must appear (default: true)
}
```

### Asset Library Object

```typescript
{
  images?: string;       // URL to image asset library or API
  videos?: string;       // URL to video asset library or API
  templates?: string;    // URL to creative templates library
}
```

## Integration with AdCP Tasks

### create_media_buy

Include brand card in media buy creation to provide context for creative generation:

```json
{
  "buyer_ref": "campaign_2024_q1",
  "promoted_offering": "ACME Pro Widget",
  "brand_card": {
    "url": "https://acmecorp.com",
    "name": "ACME Corporation",
    "tone": "professional and innovative"
  },
  "packages": [...],
  "budget": {...}
}
```

### build_creative

Use brand card to inform creative generation:

```json
{
  "message": "Create a native ad highlighting our new product launch",
  "format_id": "display_native",
  "brand_card": {
    "url": "https://acmecorp.com",
    "logos": [
      {
        "url": "https://cdn.acmecorp.com/logo-square.png",
        "tags": ["square", "dark"]
      }
    ],
    "colors": {
      "primary": "#FF6B35",
      "secondary": "#004E89"
    },
    "tone": "professional and trustworthy"
  }
}
```

## Best Practices

### 1. Start Simple, Expand as Needed

Begin with just a URL. Add more fields only when the URL-based inference isn't sufficient:

```json
// ✅ Good starting point
{
  "url": "https://mybrand.com"
}

// ✅ Add details when needed
{
  "url": "https://mybrand.com",
  "logos": [...],
  "colors": {...}
}
```

### 2. Use Semantic Tags for Logos

Tags help creative agents select appropriate logo variants:

```json
{
  "logos": [
    {"url": "...", "tags": ["dark", "square"]},      // For light backgrounds
    {"url": "...", "tags": ["light", "square"]},     // For dark backgrounds
    {"url": "...", "tags": ["dark", "horizontal"]},  // Wide layouts
    {"url": "...", "tags": ["icon"]}                 // Small placements
  ]
}
```

### 3. Cache and Reuse Brand Cards

Brand cards are designed to be cached:

```javascript
// Cache brand card once
const brandCard = {
  url: "https://acmecorp.com",
  colors: {...},
  logos: [...]
};

// Reuse across requests
await createMediaBuy({ brand_card: brandCard, ... });
await buildCreative({ brand_card: brandCard, ... });
await buildCreative({ brand_card: brandCard, ... }); // Same card, different creative
```

### 4. Product Feeds for Multi-SKU

Large retailers should provide product feeds:

```json
{
  "url": "https://retailer.com",
  "product_feed": "https://retailer.com/products.json"
}
```

**Supported Feed Formats**: RSS, JSON Feed, Product CSV

### 5. Asset Libraries for Enterprise

Enterprise brands with large asset libraries should provide API endpoints:

```json
{
  "asset_library": {
    "images": "https://assets.brand.com/api/images",
    "videos": "https://assets.brand.com/api/videos"
  }
}
```

## Evolution and Versioning

Brand cards are versioned using the `metadata.version` field:

```json
{
  "url": "https://brand.com",
  "metadata": {
    "version": "2.1",
    "updated_date": "2024-03-15T10:00:00Z"
  }
}
```

Version updates:
- **Patch** (2.0.1): Fix typos, update contact info
- **Minor** (2.1.0): Add new assets, update colors
- **Major** (3.0.0): Complete rebrand, new identity

## Migration from brand_guidelines

For implementations using the legacy `brand_guidelines` field in `build_creative`:

**Before (Legacy)**:
```json
{
  "brand_guidelines": {
    "colors": ["#FF6B35", "#004E89"],
    "fonts": ["Helvetica Neue"],
    "tone": "professional"
  }
}
```

**After (Brand Card)**:
```json
{
  "brand_card": {
    "url": "https://brand.com",
    "colors": {
      "primary": "#FF6B35",
      "secondary": "#004E89"
    },
    "fonts": {
      "primary": "Helvetica Neue"
    },
    "tone": "professional"
  }
}
```

## Related Documentation

- **[create_media_buy](../media-buy/task-reference/create_media_buy)** - Media buy creation with brand context
- **[build_creative](../creative-protocol/task-reference/build_creative)** - AI-powered creative generation
- **[Creative Lifecycle](../media-buy/creatives/)** - Managing creative assets
- **[Data Models](./data-models)** - Core AdCP data structures
