---
title: add_creative_assets_status
sidebar_position: 4.1
---

# add_creative_assets_status

Check the status of asynchronous creative asset upload and validation.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `context_id` | string | Yes | Context identifier from the add_creative_assets response |

## Response Format

The response format varies based on the current status of the operation.

### Processing Status

```json
{
  "message": "Creative validation in progress - checking policy compliance",
  "context_id": "ctx-creative-789",
  "status": "processing",
  "progress": {
    "current_item": "pet_food_audio_15s",
    "completed": 1,
    "total": 2,
    "unit_type": "assets",
    "responsible_party": "publisher",
    "action_detail": "Reviewing creative for policy compliance"
  }
}
```

### Completed Status

```json
{
  "message": "Successfully uploaded 2 creative assets",
  "context_id": "ctx-creative-789",
  "status": "completed",
  "asset_statuses": [
    {
      "creative_id": "pet_food_30s_v1",
      "status": "approved",
      "platform_id": "gam_creative_987654",
      "review_feedback": null
    },
    {
      "creative_id": "pet_food_audio_15s",
      "status": "approved",
      "platform_id": "gam_creative_987655",
      "review_feedback": null
    }
  ]
}
```

### Partial Failure Status

```json
{
  "message": "Creative upload completed with 1 rejection",
  "context_id": "ctx-creative-789",
  "status": "completed_with_errors",
  "asset_statuses": [
    {
      "creative_id": "pet_food_30s_v1",
      "status": "rejected",
      "review_feedback": "Video contains misleading health claims",
      "suggestion": "Remove or modify health benefit statements"
    },
    {
      "creative_id": "pet_food_audio_15s",
      "status": "approved",
      "platform_id": "gam_creative_987655"
    }
  ]
}
```

### Failed Status

```json
{
  "message": "Creative upload failed",
  "context_id": "ctx-creative-789",
  "status": "failed",
  "error": {
    "code": "INVALID_FORMAT",
    "message": "Video codec not supported for CTV delivery",
    "suggestion": "Re-encode video using H.264 codec"
  }
}
```

### Invalid Context Status

```json
{
  "error": {
    "code": "INVALID_CONTEXT",
    "message": "Context not found or expired",
    "suggestion": "Start a new add_creative_assets operation"
  }
}
```

## Status Values

- `processing`: Assets are being uploaded and validated
- `completed`: All assets processed successfully
- `completed_with_errors`: Some assets approved, some rejected
- `failed`: Operation failed completely

## Asset Status Values

Each asset can have these statuses:
- `uploading`: Asset is being uploaded
- `validating`: Technical validation in progress
- `reviewing`: Policy review in progress
- `approved`: Asset approved and ready for delivery
- `rejected`: Asset rejected due to policy or technical issues
- `pending_manual`: Requires human review

## Usage Notes

- Poll this endpoint after receiving a `processing` status from `add_creative_assets`
- Creative validation can take time due to:
  - File upload and processing
  - Technical validation (format, size, duration)
  - Policy compliance checks
  - Manual review requirements
- Assets may be partially approved (some approved, some rejected)
- Rejected assets can be re-uploaded after addressing feedback

## Example

### Request
```json
{
  "context_id": "ctx-creative-789"
}
```

### Response - Processing
```json
{
  "message": "Uploading and validating 3 creative assets",
  "context_id": "ctx-creative-789",
  "status": "processing",
  "progress": {
    "current_item": "display_banner_300x250",
    "completed": 2,
    "total": 3,
    "unit_type": "assets",
    "responsible_party": "third_party",
    "action_detail": "Brand safety verification service checking content"
  }
}
```

### Response - Completed with Suggestions
```json
{
  "message": "Successfully uploaded 2 creative assets with optimization suggestions",
  "context_id": "ctx-creative-789",
  "status": "completed",
  "asset_statuses": [
    {
      "creative_id": "pet_food_30s_v1",
      "status": "approved",
      "platform_id": "gam_creative_987654",
      "review_feedback": null,
      "suggested_adaptations": [
        {
          "adaptation_id": "adapt_vertical_v1",
          "format_id": "video_vertical_9x16",
          "name": "Mobile Vertical Version",
          "description": "9:16 version optimized for mobile feeds",
          "rationale": "Mobile inventory converts 35% better with vertical format",
          "estimated_performance_lift": 35.0
        }
      ]
    },
    {
      "creative_id": "pet_food_audio_15s",
      "status": "approved",
      "platform_id": "gam_creative_987655",
      "review_feedback": null,
      "suggested_adaptations": []
    }
  ]
}
```

## Common Scenarios

### Handling Rejections
```python
# Check status after upload
status = await mcp.call_tool("add_creative_assets_status", {
    "context_id": "ctx-creative-789"
})

if status["status"] == "completed_with_errors":
    for asset in status["asset_statuses"]:
        if asset["status"] == "rejected":
            print(f"Asset {asset['creative_id']} rejected:")
            print(f"  Reason: {asset['review_feedback']}")
            print(f"  Fix: {asset.get('suggestion', 'Contact support')}")
            
            # Re-upload after fixing
            await fix_and_reupload(asset)
```

### Monitoring Upload Progress
```python
# Poll for creative upload status
while True:
    status = await mcp.call_tool("add_creative_assets_status", {
        "context_id": context_id
    })
    
    if status["status"] == "processing":
        progress = status.get("progress", {})
        print(f"Processing {progress.get('current_asset', 'assets')}...")
        print(f"Progress: {progress.get('assets_processed', 0)}/{progress.get('total_assets', '?')}")
    elif status["status"] in ["completed", "completed_with_errors", "failed"]:
        break
        
    await sleep(5)
```

## Implementation Guide

Publishers should:
1. Validate creative formats against package requirements
2. Check file integrity and technical specifications
3. Run policy compliance checks
4. Provide clear rejection reasons with actionable feedback
5. Suggest format adaptations when beneficial
6. Track upload progress for large files