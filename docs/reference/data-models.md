---
sidebar_position: 3
title: Data Models
---

# Data Models

Core data structures used throughout AdCP.

## Product

Represents available advertising inventory.

```typescript
interface Product {
  product_id: string;
  name: string;
  description: string;
  formats: Format[];
  delivery_type: 'guaranteed' | 'non_guaranteed';
  is_fixed_price: boolean;
  cpm?: number;
  min_spend?: number;
  targeting_capabilities: string[];
  measurement?: {
    type: string;
    attribution: string;
    reporting: string;
  };
}
```

## Media Buy

Represents a purchased advertising campaign.

```typescript
interface MediaBuy {
  media_buy_id: string;
  status: 'pending_activation' | 'active' | 'paused' | 'completed';
  promoted_offering: string;
  total_budget: number;
  packages: Package[];
  creative_deadline?: string;
  created_at: string;
  updated_at: string;
}
```

## Package

A specific product within a media buy (line item).

```typescript
interface Package {
  package_id: string;
  product_id: string;
  budget: number;
  impressions?: number;
  targeting_overlay?: Targeting;
  creative_assignments?: CreativeAssignment[];
  status: 'draft' | 'active' | 'paused' | 'completed';
}
```

## Creative Asset

Uploaded creative content.

```typescript
interface CreativeAsset {
  creative_id: string;
  name: string;
  format: string;
  url?: string;
  status: 'processing' | 'approved' | 'rejected' | 'pending_review';
  compliance?: {
    status: string;
    issues?: string[];
  };
}
```

## Targeting

Audience targeting criteria.

```typescript
interface Targeting {
  geo_country_any_of?: string[];
  geo_region_any_of?: string[];
  audience_segment_any_of?: string[];
  signals?: string[];
  frequency_cap?: {
    suppress_minutes: number;
    scope: 'media_buy' | 'package';
  };
}
```

## Response Format

Standard response structure (MCP).

```typescript
interface Response {
  message: string;           // Human-readable summary
  context_id?: string;        // Session continuity
  data?: any;                // Operation-specific data
  errors?: Error[];          // Non-fatal warnings
  clarification_needed?: boolean;
}
```

## Error

Standard error structure.

```typescript
interface Error {
  code: string;
  message: string;
  field?: string;
  suggestion?: string;
  details?: any;
}
```

## Common Enums

```typescript
// Delivery Types
type DeliveryType = 'guaranteed' | 'non_guaranteed';

// Media Buy Status
type MediaBuyStatus = 'pending_activation' | 'active' | 'paused' | 'completed';

// Creative Status  
type CreativeStatus = 'processing' | 'approved' | 'rejected' | 'pending_review';

// Pacing
type Pacing = 'even' | 'asap' | 'front_loaded';
```