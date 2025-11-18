# Extension Fields

## Overview

AdCP supports extension fields via the `ext` object at three distinct layers:

- **Request extensions** - Operational metadata, test flags, caller context
- **Response extensions** - Processing diagnostics, debug info, operation hints
- **Object extensions** - Domain-specific persistent data

Extensions enable:

- **Platform-specific functionality** - Custom metadata for different ad platforms
- **Private agreements** - Publisher-buyer specific data exchange
- **Experimental features** - Testing capabilities before standardization
- **Forward compatibility** - Supporting emerging ad tech capabilities

Extension fields follow industry conventions established by IAB standards like OpenRTB, which uses extensions at multiple layers for different purposes.

## Extension Object

### Schema Pattern

Core objects include an optional `ext` field:

```json
{
  "product_id": "ctv_premium",
  "name": "Connected TV Premium Inventory",
  "ext": {
    "platform_specific_field": "value",
    "custom_metadata": {
      "nested": "data"
    }
  }
}
```

The `ext` object:
- Is always **optional** (never required)
- Accepts any valid JSON structure
- Must be preserved by implementations (even unknown fields)
- Is not validated by AdCP schemas (implementation-specific validation allowed)

### Extension Layers

AdCP supports extensions at three distinct layers, following the OpenRTB pattern:

#### 1. Request Extensions

All task request schemas support `ext` for operational metadata:

```json
{
  "promoted_offering": "Tesla Model 3",
  "packages": [...],
  "context": {
    "ui_session_id": "sess_123"  // Echoed unchanged
  },
  "ext": {
    "buyer_internal_campaign_id": "camp_abc",
    "test_mode": true,
    "trace_id": "trace_123"
  }
}
```

**Use request.ext for:**
- Caller identification and tracing
- Internal tracking IDs
- Test/staging mode flags
- Experimental feature flags
- Platform-specific hints that MAY affect behavior

#### 2. Response Extensions

All task response schemas support `ext` for processing metadata:

```json
{
  "media_buy": {
    "media_buy_id": "mb_123",
    "ext": {...}  // MediaBuy-level data
  },
  "context": {
    "ui_session_id": "sess_123"  // Echoed from request
  },
  "ext": {
    "processing_time_ms": 1523,
    "estimated_approval_time": "2-4 hours",
    "debug_trace_id": "trace_123",
    "next_recommended_action": "upload_creatives"
  }
}
```

**Use response.ext for:**
- Processing diagnostics (timing, queue position)
- Debug information
- Estimated timelines or next steps
- Platform-specific dashboard URLs
- Warnings or informational messages

#### 3. Object Extensions

Core domain objects support `ext` for persistent data:

| Object | Use Cases |
|--------|-----------|
| **Product** | Platform inventory metadata, content classifications, custom targeting capabilities |
| **MediaBuy** | Campaign tracking IDs, attribution settings, custom reporting requirements |
| **CreativeManifest** | AI generation metadata, localization info, brand safety scores |
| **Package** | Delivery preferences, companion ad settings, custom optimization flags |

**Use object.ext for:**
- Persistent domain-specific data
- Platform campaign IDs
- Object-scoped custom fields
- Data that persists across API calls

### Extension vs Context

**`context`** and **`ext`** serve different purposes:

- **`context`** = Opaque correlation data, echoed unchanged (UI session IDs, tokens)
- **`ext`** = Implementation-specific parameters that MAY affect behavior

```json
{
  "context": {
    "ui_session_id": "sess_123",  // Just echoed back
    "user_token": "opaque_token"  // Not parsed
  },
  "ext": {
    "test_mode": true,            // MAY affect behavior
    "buyer_campaign_id": "camp_123"  // Used for tracking
  }
}
```

## Namespacing Conventions

To avoid collisions between different implementations, extensions **SHOULD** follow these naming patterns:

### Vendor/Platform Fields

Use company or platform name as prefix:

```json
{
  "ext": {
    "roku_app_ids": ["123456", "789012"],
    "roku_content_genres": ["comedy", "drama"],
    "ttd_uid2_token": "...",
    "meta_business_id": "1234567890",
    "gam_custom_targeting": {
      "category": "premium",
      "genre": "sports"
    }
  }
}
```

### Standard Extensions

Well-known industry extensions (like OpenRTB extensions) use unprefixed names:

```json
{
  "ext": {
    "schain": {
      "ver": "1.0",
      "complete": 1,
      "nodes": [
        {
          "asi": "publisher.com",
          "sid": "12345",
          "hp": 1
        }
      ]
    }
  }
}
```

### Experimental Features

Use `x_` prefix for features being tested before standardization:

```json
{
  "ext": {
    "x_ai_creative_generation": {
      "model": "dall-e-3",
      "prompt_engineering": "enabled"
    },
    "x_carbon_measurement": {
      "kg_co2": 0.05,
      "offset_provider": "example.com"
    }
  }
}
```

## Validation Rules

### AdCP Schema Validation

- ✅ **Accepts** any valid JSON in `ext`
- ✅ **Does not enforce** specific `ext` structure
- ✅ **Validates** all standard fields strictly
- ⚠️ **May warn** about unknown top-level fields (typo detection)

### Implementation Requirements

Implementations **MUST**:
- Accept products/responses with `ext` fields they don't recognize
- Preserve unknown `ext` data when passing through to other systems
- Not reject requests solely due to unknown `ext` content

Implementations **MAY**:
- Validate vendor-specific `ext` fields per private agreements
- Document all custom `ext` fields they produce or consume
- Ignore `ext` data they don't understand

Implementations **SHOULD**:
- Follow namespacing conventions to avoid collisions
- Document their `ext` usage in API documentation
- Maintain backward compatibility when changing `ext` structures

## Common Extension Patterns

### Request-Level: Testing and Tracing

Request extensions for operational metadata:

```json
// create_media_buy request with tracing
{
  "promoted_offering": "Tesla Model 3",
  "packages": [...],
  "ext": {
    // Testing
    "test_mode": true,
    "test_scenario": "creative_deadline_edge_case",
    "skip_credit_check": true,

    // Tracing and observability
    "trace_id": "trace_abc123",
    "caller_system": "acme_trading_desk_v2.1",
    "buyer_internal_campaign_id": "camp_xyz",

    // Experimental features
    "beta_features": ["multi_currency", "auto_optimization"]
  }
}
```

### Response-Level: Processing Diagnostics

Response extensions for operational feedback:

```json
// create_media_buy response with diagnostics
{
  "media_buy": {
    "media_buy_id": "mb_123",
    "status": "pending_approval"
  },
  "ext": {
    // Processing metadata
    "processing_time_ms": 1523,
    "queue_position": 42,
    "estimated_approval_time": "2-4 hours",

    // Debug information
    "debug_trace_id": "trace_abc123",
    "validation_warnings": ["creative_deadline_tight"],

    // Implementation hints
    "next_recommended_action": "upload_creatives",
    "help_url": "https://help.publisher.com/campaign/mb_123",
    "platform_dashboard_url": "https://roku.com/dashboard/deal_12345"
  }
}
```

### Object-Level: Supply Chain Transparency

Following [OpenRTB SupplyChain specification](https://github.com/InteractiveAdvertisingBureau/openrtb/blob/master/supplychainobject.md):

```json
{
  "product_id": "ctv_premium",
  "ext": {
    "schain": {
      "ver": "1.0",
      "complete": 1,
      "nodes": [
        {
          "asi": "directseller.com",
          "sid": "00001",
          "hp": 1,
          "rid": "bid-request-1",
          "name": "Publisher A",
          "domain": "publishera.com"
        }
      ]
    }
  }
}
```

### Platform-Specific Targeting

CTV platforms often have unique targeting capabilities:

```json
{
  "product_id": "ctv_premium",
  "ext": {
    "roku_content_genres": ["comedy", "drama", "documentary"],
    "roku_content_rating": ["TV-PG", "TV-14"],
    "roku_viewer_age_ranges": ["18-24", "25-34", "35-44"]
  }
}
```

### Measurement Extensions

Custom measurement and reporting requirements:

```json
{
  "media_buy_id": "mb_123",
  "ext": {
    "buyer_campaign_id": "campaign_xyz_2024",
    "attribution_window_days": 30,
    "attribution_model": "linear",
    "nielsen_dar_enabled": true,
    "comscore_tracking": {
      "client_id": "1234567",
      "campaign_id": "camp_abc"
    }
  }
}
```

### Creative Metadata

AI-generated creative tracking and brand safety:

```json
{
  "format_id": {
    "agent_url": "https://creative.adcontextprotocol.org",
    "id": "display_300x250"
  },
  "ext": {
    "ai_generated": true,
    "generation_model": "dall-e-3",
    "brand_safety_score": 0.95,
    "sentiment_analysis": "positive",
    "localization_available": ["en-US", "es-ES", "fr-FR"]
  }
}
```

### Data Provider Extensions

Signal metadata for transparency and performance:

```json
{
  "signal_agent_segment_id": "seg_auto_intenders",
  "ext": {
    "data_recency_hours": 24,
    "match_rate_estimate": 0.82,
    "gdpr_legal_basis": "legitimate_interest",
    "ccpa_compliance": true,
    "refresh_frequency": "daily"
  }
}
```

## Best Practices

### DO ✅

- **Use vendor prefixes** for platform-specific fields
- **Preserve unknown extensions** when forwarding data
- **Document your extensions** in API docs
- **Keep extensions optional** - don't make them required for functionality
- **Use semantic names** that clearly describe the data
- **Follow JSON conventions** - camelCase or snake_case consistently
- **Include units** in field names when applicable (e.g., `carbon_kg` not just `carbon`)

### DON'T ❌

- **Don't nest `ext` inside `ext`** - keep it single-level
- **Don't duplicate standard fields** - use different semantic names
- **Don't include large binaries** - use URLs for assets, `ext` for metadata
- **Don't put secrets** in `ext` - use proper authentication mechanisms
- **Don't include PII** without proper consent and encryption
- **Don't break compatibility** - treat your `ext` fields like standard API fields
- **Don't duplicate object data in response ext** - keep layers separate
- **Don't use ext for protocol concerns** - task_id, status, webhooks are protocol layer
- **Don't use context for behavior changes** - context is opaque, ext is parseable

### Layer Separation Anti-Patterns

**❌ Bad: Duplicating object data in response ext**
```json
{
  "media_buy": {
    "ext": {"platform_id": "123"}
  },
  "ext": {"platform_id": "123"}  // ❌ Redundant
}
```

**✅ Good: Each layer has distinct data**
```json
{
  "media_buy": {
    "ext": {"platform_campaign_id": "123"}  // Persistent state
  },
  "ext": {
    "processing_time_ms": 1523,             // Request-scoped
    "dashboard_url": "https://..."          // Operational hint
  }
}
```

**❌ Bad: Protocol concerns in ext**
```json
{
  "ext": {
    "task_id": "...",      // ❌ Protocol layer
    "status": "...",       // ❌ Protocol layer
    "webhook_url": "..."   // ❌ Protocol layer
  }
}
```

**❌ Bad: Behavior flags in context**
```json
{
  "context": {
    "test_mode": true  // ❌ Should be in ext
  }
}
```

## Migration from Standard Fields

If an extension becomes widely adopted, it may be promoted to a standard AdCP field in a future version:

1. **Deprecation period** - Extension remains supported alongside new standard field
2. **Documentation** - Migration guide shows how to transition
3. **Dual support** - Accept both extension and standard field during transition
4. **Removal timeline** - Clear timeline for when extension support ends (typically 12+ months)

Example migration:

```json
// Old: Extension field (deprecated but still supported)
{
  "product_id": "ctv_premium",
  "ext": {
    "roku_content_genres": ["comedy", "drama"]
  }
}

// New: Promoted to standard field
{
  "product_id": "ctv_premium",
  "content_genres": ["comedy", "drama"]  // Now standard field
}
```

## Extension Registry

This section documents commonly-used extensions that have emerged across implementations. These are not required but represent established patterns.

### Industry Standard Extensions

| Extension | Origin | Description | Objects |
|-----------|--------|-------------|---------|
| `schain` | OpenRTB | Supply chain transparency | Product, MediaBuy |

### Platform Extensions

Document commonly-used platform extensions here as they emerge.

## Questions?

For questions about extension field design or to propose new standard fields, see the [AdCP GitHub discussions](https://github.com/adcontextprotocol/adcp/discussions).
