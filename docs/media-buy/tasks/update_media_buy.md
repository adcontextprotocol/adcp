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
  "message": "string",
  "context_id": "string",
  "status": "string",
  "implementation_date": "string",
  "detail": "string",
  "affected_packages": ["string"]
}
```

### Field Descriptions

- **message**: Human-readable summary of the updates made and their impact
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
  "message": "Campaign paused successfully. All 2 packages have stopped delivering impressions. You've spent $16,875 of your $50,000 budget (33.8%). Campaign can be resumed at any time to continue delivery.",
  "context_id": "ctx-media-buy-abc123",
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

#### Response - Immediate Update
```json
{
  "message": "Campaign updated successfully. Budget increased from $50,000 to $75,000 (+50%), giving you more reach for the extended flight through February 28. CTV package switched to front-loaded pacing to maximize early delivery, while audio package has been paused. Changes take effect immediately.",
  "context_id": "ctx-media-buy-abc123",
  "status": "accepted",
  "implementation_date": "2024-02-08T00:00:00Z",
  "detail": "Updated budget to $75,000, extended end date, modified 2 packages",
  "affected_packages": ["pkg_ctv_prime_ca_ny", "pkg_audio_drive_ca_ny"]
}
```

### Example 3: Update Requiring Approval

#### Request
```json
{
  "context_id": "ctx-media-buy-abc123",
  "media_buy_id": "gam_1234567890",
  "total_budget": 150000
}
```

#### Response - Pending Approval
```json
{
  "message": "Budget increase to $150,000 requires manual approval due to the significant change (+200%). This typically takes 2-4 hours during business hours. Your campaign continues to deliver at the current $50,000 budget until approved. I'll notify you once the increase is approved.",
  "context_id": "ctx-media-buy-abc123",
  "status": "pending_approval",
  "implementation_date": null,
  "detail": "Budget increase requires approval (task_id: approval_98765)",
  "affected_packages": []
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

## Status Checking (MCP Only)

### update_media_buy_status

For MCP implementations, use this endpoint to check the status of an asynchronous media buy update.

#### Request
```json
{
  "context_id": "ctx-update-mb-321"  // Required - from update_media_buy response
}
```

#### Response Examples

**Processing:**
```json
{
  "message": "Media buy update in progress - applying changes",
  "context_id": "ctx-update-mb-321",
  "status": "processing",
  "progress": {
    "completed": 1,
    "total": 2,
    "unit_type": "packages",
    "responsible_party": "system"
  }
}
```

**Completed:**
```json
{
  "message": "Successfully updated media buy gam_1234567890",
  "context_id": "ctx-update-mb-321",
  "status": "completed",
  "implementation_date": "2024-02-08T00:00:00Z",
  "affected_packages": ["pkg_ctv_prime_ca_ny"]
}
```

**Pending Approval:**
```json
{
  "message": "Media buy update requires approval",
  "context_id": "ctx-update-mb-321",
  "status": "pending_manual",
  "responsible_party": "advertiser",
  "action_detail": "Finance team must approve budget increase"
}
```

## Usage Notes

- Updates typically take effect immediately unless approval is required
- Budget increases may require approval based on publisher policies
- Pausing a campaign preserves all settings and can be resumed anytime
- Package-level updates override campaign-level settings
- Some updates may affect pacing calculations and delivery patterns

## Implementation Guide

### Generating Update Messages

The `message` field should clearly explain what changed and the impact:

```python
def generate_update_message(request, response, current_state):
    changes = []
    
    # Budget changes
    if request.total_budget:
        old_budget = current_state.total_budget
        change_pct = ((request.total_budget - old_budget) / old_budget) * 100
        changes.append(f"Budget {'increased' if change_pct > 0 else 'decreased'} from ${old_budget:,} to ${request.total_budget:,} ({change_pct:+.0f}%)")
    
    # Campaign pause/resume
    if request.active is not None:
        if request.active:
            changes.append("Campaign resumed")
        else:
            spent_pct = (current_state.spent / current_state.total_budget) * 100
            changes.append(f"Campaign paused. You've spent ${current_state.spent:,} of your ${current_state.total_budget:,} budget ({spent_pct:.1f}%)")
    
    # Package updates
    if request.packages:
        package_changes = summarize_package_changes(request.packages)
        changes.extend(package_changes)
    
    # Build message based on status
    if response.status == "accepted":
        return f"Campaign updated successfully. {'. '.join(changes)}. Changes take effect immediately."
    elif response.status == "pending_approval":
        return f"{changes[0]} requires manual approval due to {get_approval_reason(request)}. This typically takes 2-4 hours during business hours. Your campaign continues with current settings until approved."
```
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