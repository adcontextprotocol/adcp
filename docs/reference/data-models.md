---
sidebar_position: 3
title: Data Models
---

# Data Models

Core data structures used throughout AdCP.

## Product

Represents available advertising inventory.

**JSON Schema**: [`/schemas/v1/core/product.json`](/schemas/v1/core/product.json)

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

**JSON Schema**: [`/schemas/v1/core/media-buy.json`](/schemas/v1/core/media-buy.json)

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

**JSON Schema**: [`/schemas/v1/core/package.json`](/schemas/v1/core/package.json)

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

**JSON Schema**: [`/schemas/v1/core/creative-asset.json`](/schemas/v1/core/creative-asset.json)

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

**JSON Schema**: [`/schemas/v1/core/targeting.json`](/schemas/v1/core/targeting.json)

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

## Protocol Response Format

Protocol-level response wrapper (MCP/A2A).

**JSON Schema**: [`/schemas/v1/core/response.json`](/schemas/v1/core/response.json)

```typescript
interface ProtocolResponse {
  message: string;              // Human-readable summary (protocol level)
  context_id?: string;          // Session continuity (protocol level)
  data: any;                   // AdCP task-specific response data
  errors?: Error[];            // Non-fatal warnings (protocol level)
}
```

**Note**: Individual AdCP task schemas contain only the application-level data that goes in the `data` field of the protocol response.

## Error

Standard error structure.

**JSON Schema**: [`/schemas/v1/core/error.json`](/schemas/v1/core/error.json)

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
// Delivery Types - Schema: /schemas/v1/enums/delivery-type.json
type DeliveryType = 'guaranteed' | 'non_guaranteed';

// Media Buy Status - Schema: /schemas/v1/enums/media-buy-status.json
type MediaBuyStatus = 'pending_activation' | 'active' | 'paused' | 'completed';

// Creative Status - Schema: /schemas/v1/enums/creative-status.json
type CreativeStatus = 'processing' | 'approved' | 'rejected' | 'pending_review';

// Pacing - Schema: /schemas/v1/enums/pacing.json
type Pacing = 'even' | 'asap' | 'front_loaded';
```

**Additional Enum Schemas**:
- [`delivery-type.json`](/schemas/v1/enums/delivery-type.json) - guaranteed vs non_guaranteed
- [`media-buy-status.json`](/schemas/v1/enums/media-buy-status.json) - Media buy lifecycle status
- [`package-status.json`](/schemas/v1/enums/package-status.json) - Package lifecycle status
- [`creative-status.json`](/schemas/v1/enums/creative-status.json) - Creative review status
- [`pacing.json`](/schemas/v1/enums/pacing.json) - Budget pacing strategies
- [`frequency-cap-scope.json`](/schemas/v1/enums/frequency-cap-scope.json) - Frequency cap scope

## Schema Versioning

All AdCP requests and responses include an `adcp_version` field for version negotiation and backward compatibility.

### Version Field

**In Requests** (optional, defaults to latest):
```json
{
  "adcp_version": "1.0.0",
  "buyer_ref": "campaign-123",
  // ... other request fields
}
```

**In Responses** (required):
```json
{
  "adcp_version": "1.0.0", 
  "media_buy_id": "mb-789",
  // ... other response fields
}
```

### Version Format

AdCP uses [semantic versioning](https://semver.org/):
- **Major** (X.y.z): Breaking changes
- **Minor** (x.Y.z): Backward-compatible additions  
- **Patch** (x.y.Z): Bug fixes and clarifications

### Version Negotiation

**Client Behavior:**
- Include `adcp_version` to request a specific schema version
- Omit `adcp_version` to use server's latest supported version
- Check `adcp_version` in responses to confirm compatibility

**Server Behavior:**  
- Honor the requested version if supported
- Use latest version if no version specified
- Return error if requested version is unsupported
- Always include `adcp_version` in responses

### Migration Strategy

**Minor Version Updates** (1.0.0 → 1.1.0):
- Add optional fields or new tasks
- Backward compatible - existing clients continue working
- Clients can adopt new features at their own pace

**Major Version Updates** (1.0.0 → 2.0.0):
- Breaking changes require client updates
- Servers may support multiple major versions during transition
- Migration guides provided for breaking changes

## JSON Schema Registry

View all available schemas: [`/schemas/v1/index.json`](/schemas/v1/index.json)