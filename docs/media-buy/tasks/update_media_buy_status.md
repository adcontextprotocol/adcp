---
title: update_media_buy_status
sidebar_position: 5.1
---

# update_media_buy_status

Check the status of an asynchronous media buy update operation.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `context_id` | string | Yes | Context identifier from the update_media_buy response |

## Response Format

The response format varies based on the current status of the operation.

### Processing Status

```json
{
  "message": "Media buy update in progress - applying changes to packages",
  "context_id": "ctx-update-mb-321",
  "status": "processing",
  "progress": {
    "completed": 1,
    "total": 2,
    "unit_type": "packages",
    "responsible_party": "system",
    "action_detail": "Updating package configurations"
  }
}
```

### Completed Status

```json
{
  "message": "Successfully updated media buy gam_1234567890",
  "context_id": "ctx-update-mb-321",
  "status": "completed",
  "implementation_date": "2024-02-08T00:00:00Z",
  "detail": "Budget increased to $75,000, flight extended to Feb 28",
  "affected_packages": ["pkg_ctv_prime_ca_ny", "pkg_audio_drive_ca_ny"]
}
```

### Failed Status

```json
{
  "message": "Media buy update failed",
  "context_id": "ctx-update-mb-321",
  "status": "failed",
  "error": {
    "code": "BUDGET_EXCEEDED",
    "message": "Requested budget exceeds available credit limit",
    "suggestion": "Contact your account manager to increase credit limit"
  }
}
```

### Pending Manual Approval Status

```json
{
  "message": "Media buy update requires approval",
  "context_id": "ctx-update-mb-321",
  "status": "pending_manual",
  "task_id": "task_update_approval_678",
  "reason": "Budget increase exceeds automatic approval threshold",
  "estimated_approval_time": "1-2 hours during business hours",
  "responsible_party": "advertiser",
  "action_detail": "Advertiser finance team must approve budget increase"
}
```

### Invalid Context Status

```json
{
  "error": {
    "code": "INVALID_CONTEXT",
    "message": "Context not found or expired",
    "suggestion": "Start a new update_media_buy operation"
  }
}
```

## Status Values

- `processing`: Update is being processed
- `completed`: Update completed successfully
- `failed`: Update failed with error
- `pending_manual`: Awaiting human approval for changes

## Usage Notes

- Poll this endpoint after receiving a `processing` status from `update_media_buy`
- Updates may require approval if they:
  - Increase budget significantly
  - Change targeting to restricted categories
  - Modify flight dates that affect inventory
- PATCH semantics apply - only specified fields are updated
- Context remains valid until the operation completes

## Example

### Request
```json
{
  "context_id": "ctx-update-mb-321"
}
```

### Response - Processing
```json
{
  "message": "Updating media buy - validating budget changes",
  "context_id": "ctx-update-mb-321",
  "status": "processing",
  "progress": {
    "completed": 0,
    "total": 2,
    "unit_type": "packages",
    "responsible_party": "system",
    "action_detail": "Validating budget changes"
  }
}
```

### Response - Completed
```json
{
  "message": "Successfully paused media buy gam_1234567890",
  "context_id": "ctx-update-mb-321",
  "status": "completed",
  "implementation_date": "2024-02-08T14:30:00Z",
  "detail": "All packages paused",
  "affected_packages": ["pkg_ctv_prime_ca_ny", "pkg_audio_drive_ca_ny"]
}
```

## Common Update Scenarios

### Pausing a Campaign
```python
# Initial request
response = await mcp.call_tool("update_media_buy", {
    "media_buy_id": "gam_1234567890",
    "active": false
})

if response["status"] == "processing":
    # Poll for completion
    while True:
        status = await mcp.call_tool("update_media_buy_status", {
            "context_id": response["context_id"]
        })
        if status["status"] in ["completed", "failed"]:
            break
        await sleep(5)
```

### Budget Increase
```python
# Request budget increase
response = await mcp.call_tool("update_media_buy", {
    "media_buy_id": "gam_1234567890",
    "total_budget": 100000  # Doubling budget
})

# May require approval for large increases
if response["status"] == "processing":
    status = await mcp.call_tool("update_media_buy_status", {
        "context_id": response["context_id"]
    })
    
    if status["status"] == "pending_manual":
        # Notify user that approval is needed
        print(f"Budget increase requires approval: {status['reason']}")
        print(f"Expected approval time: {status['estimated_approval_time']}")
```

## Implementation Guide

Publishers should:
1. Track all update operations by context_id
2. Validate changes against business rules
3. Flag updates requiring approval
4. Apply changes atomically when possible
5. Provide clear feedback on what changed