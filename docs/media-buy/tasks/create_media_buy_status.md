---
title: create_media_buy_status
sidebar_position: 3.1
---

# create_media_buy_status

Check the status of an asynchronous media buy creation operation.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `context_id` | string | Yes | Context identifier from the create_media_buy response |

## Response Format

The response format varies based on the current status of the operation.

### Processing Status

```json
{
  "message": "Media buy creation in progress - validating inventory availability",
  "context_id": "ctx-create-mb-456",
  "status": "processing",
  "progress": {
    "current_step": "inventory_validation",
    "completed": 2,
    "total": 5,
    "unit_type": "steps",
    "responsible_party": "system"
  }
}
```

### Completed Status

```json
{
  "message": "Successfully created your $50,000 media buy",
  "context_id": "ctx-create-mb-456",
  "status": "completed",
  "media_buy_id": "gam_1234567890",
  "media_buy_status": "pending_activation",
  "creative_deadline": "2024-01-30T23:59:59Z",
  "detail": "Media buy created in Google Ad Manager",
  "next_steps": [
    "Upload creative assets before deadline",
    "Assets will be reviewed by ad server",
    "Campaign will auto-activate after approval"
  ]
}
```

### Failed Status

```json
{
  "message": "Media buy creation failed due to insufficient inventory",
  "context_id": "ctx-create-mb-456",
  "status": "failed",
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "Requested inventory not available for the specified dates",
    "suggestion": "Try adjusting your flight dates or selecting different products"
  }
}
```

### Pending Manual Approval Status

```json
{
  "message": "Media buy requires manual approval",
  "context_id": "ctx-create-mb-456",
  "status": "pending_manual",
  "task_id": "task_approval_12345",
  "estimated_approval_time": "2-4 hours during business hours",
  "reason": "Campaign budget exceeds automatic approval threshold",
  "responsible_party": "publisher",
  "action_detail": "Sales team reviewing campaign parameters"
}
```

### Invalid Context Status

```json
{
  "error": {
    "code": "INVALID_CONTEXT",
    "message": "Context not found or expired",
    "suggestion": "Start a new create_media_buy operation"
  }
}
```

## Status Values

- `processing`: Operation is being processed
- `completed`: Operation completed successfully
- `failed`: Operation failed with error
- `pending_manual`: Awaiting human approval (HITL)

## Usage Notes

- Poll this endpoint after receiving a `processing` status from `create_media_buy`
- Recommended polling intervals:
  - Every 1-2 seconds for the first 10 seconds
  - Every 5-10 seconds for the next minute
  - Every 30-60 seconds after that
  - Every 5 minutes for `pending_manual` status
- Context remains valid until the operation completes or fails
- For `pending_manual` status, the operation may take hours or days

## Example

### Request
```json
{
  "context_id": "ctx-create-mb-456"
}
```

### Response - Still Processing
```json
{
  "message": "Media buy creation in progress - creating line items",
  "context_id": "ctx-create-mb-456",
  "status": "processing",
  "progress": {
    "current_step": "line_item_creation",
    "completed": 4,
    "total": 5,
    "unit_type": "steps",
    "responsible_party": "system",
    "action_detail": "Creating line items in ad server"
  }
}
```

### Response - Completed
```json
{
  "message": "Successfully created your $50,000 CTV and Audio campaign targeting pet owners",
  "context_id": "ctx-create-mb-456",
  "status": "completed",
  "media_buy_id": "gam_1234567890",
  "media_buy_status": "pending_activation",
  "creative_deadline": "2024-01-30T23:59:59Z",
  "detail": "Created 2 line items in Google Ad Manager",
  "next_steps": [
    "Upload video creative for CTV package by Jan 30",
    "Upload audio creative for drive time package by Jan 30",
    "Campaign will activate automatically once creatives are approved"
  ]
}
```

## Implementation Guide

Publishers should implement this endpoint to:
1. Return the current status of the async operation
2. Provide meaningful progress updates when possible
3. Include all relevant data upon completion
4. Return clear error messages for failures
5. Indicate when manual approval is required

The endpoint should be lightweight and optimized for frequent polling.