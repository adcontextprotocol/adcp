---
title: update_media_buy
sidebar_position: 7
---

# update_media_buy

Update campaign and package settings. This task supports partial updates and handles any required approvals.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `media_buy_id` | string | No* | Publisher's ID of the media buy to update |
| `buyer_ref` | string | No* | Buyer's reference for the media buy to update |
| `active` | boolean | No | Pause/resume the entire media buy |
| `start_time` | string | No | New start date/time in ISO 8601 format (UTC unless timezone specified) |
| `end_time` | string | No | New end date/time in ISO 8601 format (UTC unless timezone specified) |
| `budget` | Budget | No | New budget configuration (see Budget Object in create_media_buy) |
| `packages` | PackageUpdate[] | No | Package-specific updates (see Package Update Object below) |

*Either `media_buy_id` or `buyer_ref` must be provided

### Package Update Object

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `package_id` | string | No* | Publisher's ID of package to update |
| `buyer_ref` | string | No* | Buyer's reference for the package to update |
| `budget` | Budget | No | New budget configuration for this package (see Budget Object in create_media_buy) |
| `active` | boolean | No | Pause/resume specific package |
| `targeting_overlay` | TargetingOverlay | No | Update targeting for this package (see Targeting Overlay Object in create_media_buy) |
| `creative_ids` | string[] | No | Update creative assignments |

*Either `package_id` or `buyer_ref` must be provided

## Response (Message)

The response includes a human-readable message that:
- Confirms what changes were made and their impact
- Explains approval requirements if applicable
- Provides context on budget and pacing changes
- Describes when changes take effect

The message is returned differently in each protocol:
- **MCP**: Returned as a `message` field in the JSON response
- **A2A**: Returned as a text part in the artifact

## Response (Payload)

```json
{
  "media_buy_id": "string",
  "buyer_ref": "string",
  "implementation_date": "string",
  "affected_packages": [
    {
      "package_id": "string",
      "buyer_ref": "string"
    }
  ]
}
```

### Field Descriptions

- **media_buy_id**: Publisher's identifier for the media buy
- **buyer_ref**: Buyer's reference identifier for the media buy
- **implementation_date**: ISO 8601 timestamp when changes take effect
- **affected_packages**: Array of packages that were modified
  - **package_id**: Publisher's package identifier
  - **buyer_ref**: Buyer's reference for the package

## Protocol-Specific Examples

The AdCP payload is identical across protocols. Only the request/response wrapper differs.

### MCP Request
```json
{
  "tool": "update_media_buy",
  "arguments": {
    "buyer_ref": "nike_q1_campaign_2024",
    "budget": {
      "total": 150000,
      "currency": "USD",
      "pacing": "front_loaded"
    },
    "packages": [
      {
        "buyer_ref": "nike_ctv_sports_package",
        "budget": {
          "total": 100000,
          "currency": "USD"
        }
      }
    ]
  }
}
```

### MCP Response (Synchronous)
```json
{
  "message": "Successfully updated media buy. Budget increased to $150,000 with front-loaded pacing.",
  "status": "completed",
  "media_buy_id": "mb_12345",
  "buyer_ref": "nike_q1_campaign_2024",
  "implementation_date": "2024-02-01T00:00:00Z",
  "affected_packages": [
    {
      "package_id": "pkg_12345_001",
      "buyer_ref": "nike_ctv_sports_package"
    }
  ]
}
```

### MCP Response (Asynchronous)
```json
{
  "task_id": "task_update_456",
  "status": "working",
  "message": "Processing media buy update..."
}
```

### A2A Request
For A2A, the skill and input are sent as:
```json
{
  "skill": "update_media_buy",
  "input": {
    "buyer_ref": "nike_q1_campaign_2024",
    "budget": {
      "total": 150000,
      "currency": "USD",
      "pacing": "front_loaded"
    },
    "packages": [
      {
        "buyer_ref": "nike_ctv_sports_package",
        "budget": {
          "total": 100000,
          "currency": "USD"
        }
      }
    ]
  }
}
```

### A2A Response (Synchronous)
A2A returns results as artifacts:
```json
{
  "artifacts": [{
    "name": "update_confirmation",
    "parts": [
      {
        "kind": "text",
        "text": "Successfully updated media buy. Budget increased to $150,000 with front-loaded pacing."
      },
      {
        "kind": "data",
        "data": {
          "media_buy_id": "mb_12345",
          "buyer_ref": "nike_q1_campaign_2024",
          "implementation_date": "2024-02-01T00:00:00Z",
          "affected_packages": [
            {"package_id": "pkg_12345_001", "buyer_ref": "nike_ctv_sports_package"}
          ]
        }
      }
    ]
  }]
}
```

### A2A Response (Asynchronous with SSE)
```json
{
  "task_id": "task_update_456",
  "status": "working",
  "updates": "https://ad-server.example.com/sse/task_update_456"
}
```

SSE Updates:
```
event: status
data: {"status": "working", "message": "Validating update parameters..."}

event: status
data: {"status": "working", "message": "Applying budget changes to packages..."}

event: completed
data: {"artifacts": [{"name": "update_confirmation", "parts": [{"kind": "text", "text": "Successfully updated media buy."}, {"kind": "data", "data": {"media_buy_id": "mb_12345", "buyer_ref": "nike_q1_campaign_2024", "implementation_date": "2024-02-01T00:00:00Z", "affected_packages": [{"package_id": "pkg_12345_001", "buyer_ref": "nike_ctv_sports_package"}]}}]}]}
```

### Key Differences
- **MCP**: Direct tool call with arguments, returns flat JSON response
- **A2A**: Skill invocation with input, returns artifacts with text and data parts
- **Payload**: The `input` field in A2A contains the exact same structure as MCP's `arguments`

## Scenarios

### Example 1: Campaign Pause

#### Request
```json
{
  "buyer_ref": "purina_pet_campaign_q1",
  "active": false
}
```

#### Response
**Message**: "Campaign paused successfully. All 2 packages have stopped delivering impressions. You've spent $16,875 of your $50,000 budget (33.8%). Campaign can be resumed at any time to continue delivery."

**Payload**:
```json
{
  "media_buy_id": "gam_1234567890",
  "buyer_ref": "purina_pet_campaign_q1",
  "implementation_date": "2024-02-08T00:00:00Z",
  "affected_packages": [
    {"package_id": "gam_pkg_001", "buyer_ref": "purina_ctv_package"},
    {"package_id": "gam_pkg_002", "buyer_ref": "purina_audio_package"}
  ]
}
```

### Example 2: Complex Update

#### Request
```json
{
  "buyer_ref": "purina_pet_campaign_q1",
  "end_time": "2024-02-28T23:59:59Z",
  "budget": {
    "total": 75000,
    "currency": "USD"
  },
  "packages": [
    {
      "buyer_ref": "purina_ctv_package",
      "budget": {
        "total": 45000,
        "currency": "USD",
        "pacing": "front_loaded"
      }
    },
    {
      "buyer_ref": "purina_audio_package",
      "active": false
    }
  ]
}
```

#### Response - Immediate Update
**Message**: "Campaign updated successfully. Budget increased from $50,000 to $75,000 (+50%), giving you more reach for the extended flight through February 28. CTV package switched to front-loaded pacing to maximize early delivery, while audio package has been paused. Changes take effect immediately."

**Payload**:
```json
{
  "media_buy_id": "gam_1234567890",
  "buyer_ref": "purina_pet_campaign_q1",
  "implementation_date": "2024-02-08T00:00:00Z",
  "affected_packages": [
    {"package_id": "gam_pkg_001", "buyer_ref": "purina_ctv_package"},
    {"package_id": "gam_pkg_002", "buyer_ref": "purina_audio_package"}
  ]
}
```

### Example 3: Update Requiring Approval

#### Request
```json
{
  "buyer_ref": "purina_pet_campaign_q1",
  "budget": {
    "total": 150000,
    "currency": "USD"
  }
}
```

#### Response - Pending Approval
**Message**: "Budget increase to $150,000 requires manual approval due to the significant change (+200%). This typically takes 2-4 hours during business hours. Your campaign continues to deliver at the current $50,000 budget until approved. I'll notify you once the increase is approved."

**Payload**:
```json
{
  "media_buy_id": "gam_1234567890",
  "buyer_ref": "purina_pet_campaign_q1",
  "implementation_date": null,
  "affected_packages": []
}
```

## PATCH Semantics

This tool follows PATCH update semantics:

- **Only included fields are modified** - Omitted fields remain unchanged
- **Null values clear/reset fields** - Where applicable
- **Packages not mentioned remain unchanged** - Only listed packages are updated


## Asynchronous Updates

Both MCP and A2A support asynchronous updates for operations that may take time or require approval:

### MCP Asynchronous Flow

1. Initial request returns immediately with task_id and status "working"
2. Client polls using update_media_buy_status with the task_id
3. Final status includes the complete update results

### A2A Asynchronous Flow

1. Initial request returns task_id with SSE URL or webhook configuration
2. Updates stream via SSE or push to webhooks
3. Final event includes complete artifacts with update results

### Human-in-the-Loop Scenarios

When updates require approval:

```json
{
  "status": "input-required",
  "message": "Budget increase requires advertiser approval",
  "responsible_party": "advertiser",
  "estimated_time": "2-4 hours"
}
```

The system will:
1. Notify the responsible party
2. Maintain current campaign settings
3. Apply changes only after approval
4. Send status updates throughout the process

## Campaign-Level vs Package-Level Updates

The `update_media_buy` tool provides a unified interface that supports both campaign-level and package-level updates in a single call:

### Campaign-Level Updates
- `active`: Pause/resume entire campaign
- `budget`: Adjust overall budget configuration
- `start_time`: Change campaign start date/time
- `end_time`: Extend or shorten campaign
- `targeting_overlay`: Update global targeting
- `pacing`: Change delivery strategy

### Package-Level Updates
- Apply different changes to multiple packages in one call
- Each package can have different update parameters
- Update multiple packages in one call
- Each package update is processed independently
- Returns immediately on first error

## Status Checking

### MCP Status Checking

For MCP implementations, use the `update_media_buy_status` endpoint to check the status of an asynchronous media buy update.

#### Request
```json
{
  "task_id": "task_update_456"  // Required - from update_media_buy response
}
```

#### Response Examples

**Processing:**
```json
{
  "message": "Media buy update in progress - applying changes",
  "task_id": "task_update_456",
  "status": "working",
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
  "message": "Successfully updated media buy",
  "task_id": "task_update_456",
  "status": "completed",
  "media_buy_id": "mb_12345",
  "buyer_ref": "nike_q1_campaign_2024",
  "implementation_date": "2024-02-08T00:00:00Z",
  "affected_packages": [
    {"package_id": "pkg_12345_001", "buyer_ref": "nike_ctv_sports_package"}
  ]
}
```

**Pending Approval:**
```json
{
  "message": "Media buy update requires approval. Finance team must approve budget increase.",
  "task_id": "task_update_456",
  "status": "input-required",
  "responsible_party": "advertiser"
}
```

### A2A Status Checking

For A2A implementations, task status is delivered via:
1. **Polling**: Client can poll using the task_id
2. **Server-Sent Events (SSE)**: Real-time updates via the `updates` URL
3. **Webhooks**: Push notifications to registered endpoints

## Usage Notes

- Updates typically take effect immediately unless approval is required
- Budget increases may require approval based on publisher policies
- Pausing a campaign preserves all settings and can be resumed anytime
- Package-level updates override campaign-level settings
- Some updates may affect pacing calculations and delivery patterns

## Platform Implementation

How updates map to different platforms:

- **GAM**: Maps to Order and LineItem updates
- **Kevel**: Maps to Campaign and Flight updates  
- **Triton**: Maps to Campaign and Flight updates

## Error Handling

All update operations return a standardized response:

```json
{
    "status": "completed" | "failed" | "working" | "rejected",
    "implementation_date": "2024-01-20T10:00:00Z",  // When change takes effect
    "reason": "Error description if failed",
    "detail": "Additional context or task ID for pending states"
}
```

### Task States

Updates follow standard A2A task states:

**Normal Flow States:**
- `working`: Update is being processed
- `input-required`: Awaiting approval or additional information
- `completed`: Update successfully applied

**Error States:**
- `failed`: Update could not be completed
- `rejected`: Update was rejected by approver
- `cancelled`: Update was cancelled before completion

## Usage Notes

- Updates may require platform approval depending on the changes
- Budget increases typically process immediately
- Budget decreases may have restrictions based on delivered spend
- Pausing takes effect at the next delivery opportunity
- Campaign extensions require sufficient remaining budget
- Creative updates only affect future impressions
- Some platforms may limit which fields can be updated after activation
- When updating budgets, the system automatically recalculates impression goals based on the package's CPM rate

## Design Note

Adding new packages post-creation is not yet supported. This functionality is under consideration for a future version.