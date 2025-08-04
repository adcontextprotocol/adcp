---
title: update_media_buy
sidebar_position: 7
---

# update_media_buy

Update campaign and package settings. This task supports partial updates and handles any required approvals.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `context_id` | string | Yes | Context identifier for session persistence |
| `media_buy_id` | string | Yes | ID of the media buy to update |
| `active` | boolean | No | Pause/resume the entire media buy |
| `flight_end_date` | string | No | New end date (YYYY-MM-DD) |
| `total_budget` | number | No | New total budget in USD |
| `packages` | array | No | Package-specific updates |
| `packages[].package_id` | string | Yes | ID of package to update |
| `packages[].budget` | number | No | New package budget |
| `packages[].active` | boolean | No | Pause/resume specific package |
| `packages[].pacing` | string | No | Pacing strategy: `"even"`, `"asap"`, `"front_loaded"` |
| `packages[].impressions` | number | No | Direct impression goal |
| `packages[].daily_impressions` | number | No | Daily impression cap |
| `packages[].creative_ids` | string[] | No | Update creative assignments |

## Response Format

```json
{
  "context_id": "string",
  "status": "string",
  "implementation_date": "string",
  "detail": "string",
  "affected_packages": ["string"]
}
```

### Field Descriptions

- **context_id**: Context identifier for session persistence
- **status**: Update status (e.g., `"accepted"`, `"pending_approval"`)
- **implementation_date**: ISO 8601 timestamp when changes take effect
- **detail**: Human-readable description of changes made
- **affected_packages**: Array of package IDs that were modified

## Examples

### Example 1: Campaign Pause

#### Request
```json
{
  "context_id": "ctx-media-buy-abc123",  // From previous operations
  "media_buy_id": "gam_1234567890",
  "active": false
}
```

#### Response
```json
{
  "context_id": "ctx-media-buy-abc123",  // Server maintains context
  "status": "accepted",
  "implementation_date": "2024-02-08T00:00:00Z",
  "detail": "Order paused in Google Ad Manager",
  "affected_packages": ["pkg_ctv_prime_ca_ny", "pkg_audio_drive_ca_ny"]
}
```

### Example 2: Complex Update

#### Request
```json
{
  "context_id": "ctx-media-buy-abc123",  // From previous operations
  "media_buy_id": "gam_1234567890",
  "flight_end_date": "2024-02-28",
  "total_budget": 75000,
  "packages": [
    {
      "package_id": "pkg_ctv_prime_ca_ny",
      "budget": 45000,
      "pacing": "front_loaded"
    },
    {
      "package_id": "pkg_audio_drive_ca_ny",
      "active": false
    }
  ]
}
```

#### Response
```json
{
  "context_id": "ctx-media-buy-abc123",  // Server maintains context
  "status": "accepted",
  "implementation_date": "2024-02-08T00:00:00Z",
  "detail": "Updated budget to $75,000, extended end date, modified 2 packages",
  "affected_packages": ["pkg_ctv_prime_ca_ny", "pkg_audio_drive_ca_ny"]
}
```

## PATCH Semantics

This tool follows PATCH update semantics:

- **Only included fields are modified** - Omitted fields remain unchanged
- **Null values clear/reset fields** - Where applicable
- **Packages not mentioned remain unchanged** - Only listed packages are updated

## Package Update Schema

When updating packages within a media buy:

```typescript
interface PackageUpdate {
  package_id: string;              // Required: which package to update
  active?: boolean;                // Pause/resume package
  budget?: number;                 // New budget in dollars
  impressions?: number;            // Direct impression goal
  cpm?: number;                    // Update CPM rate
  daily_budget?: number;           // Daily spend cap
  daily_impressions?: number;      // Daily impression cap
  pacing?: "even" | "asap" | "front_loaded";
  creative_ids?: string[];         // Update creative assignments
  targeting_overlay?: Targeting;   // Package-specific targeting
}
```

## Campaign-Level vs Package-Level Updates

The `update_media_buy` tool provides a unified interface that supports both campaign-level and package-level updates in a single call:

### Campaign-Level Updates
- `active`: Pause/resume entire campaign
- `total_budget`: Adjust overall budget
- `flight_end_date`: Extend or shorten campaign
- `targeting_overlay`: Update global targeting
- `pacing`: Change delivery strategy
- `daily_budget`: Set daily spend caps

### Package-Level Updates
- Apply different changes to multiple packages in one call
- Each package can have different update parameters
- Update multiple packages in one call
- Each package update is processed independently
- Returns immediately on first error
- Supports both budget and direct impression updates

## Platform Implementation

How updates map to different platforms:

- **GAM**: Maps to Order and LineItem updates
- **Kevel**: Maps to Campaign and Flight updates  
- **Triton**: Maps to Campaign and Flight updates

## Error Handling

All update operations return a standardized response:

```json
{
    "status": "accepted" | "failed" | "pending_manual" | "pending_permission",
    "implementation_date": "2024-01-20T10:00:00Z",  // When change takes effect
    "reason": "Error description if failed",
    "detail": "Additional context or task ID for pending states"
}
```

### Pending States vs Errors

**Pending States (Normal Flow):**
- `pending_manual`: Operation requires human approval
- `pending_permission`: Operation blocked by permissions
- `pending_approval`: Awaiting ad server approval

These are NOT errors and should be handled as part of normal operation flow.

**Error States (Exceptional):**
- `failed`: Operation cannot be completed
- `AUTHENTICATION_REQUIRED`: Missing or invalid auth
- `INVALID_PARAMETER`: Bad request data
- `NOT_FOUND`: Resource doesn't exist

## Usage Notes

- Updates may require platform approval depending on the changes
- Budget increases typically process immediately
- Budget decreases may have restrictions based on delivered spend
- Pausing takes effect at the next delivery opportunity
- Date extensions require sufficient remaining budget
- Creative updates only affect future impressions
- Some platforms may limit which fields can be updated after activation
- When updating budgets, the system automatically recalculates impression goals based on the package's CPM rate

## Design Note

Adding new packages post-creation is not yet supported. This functionality is under consideration for a future version.