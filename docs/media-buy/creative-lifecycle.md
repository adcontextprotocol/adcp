---
title: Creative Lifecycle
---

# Creative Lifecycle

AdCP provides a comprehensive set of tools for managing the entire lifecycle of creative assets within a media buy. This includes initial submission, status tracking, and publisher-assisted adaptation.

## The Creative Model

A `Creative` is a simple object that links a user-defined ID to a specific format and the location of the asset.

- **`creative_id`**: A unique, client-defined identifier for the creative.
- **`format_id`**: The ID of the format the creative adheres to. This must match a format supported by the products in the media buy. See the [Creative Formats](creative-formats.md) guide for details.
- **`content_uri`**: The URI pointing to the creative asset (e.g., a VAST XML file, an image URL, or a ZIP file with HTML5 assets).

### Example Creative
```json
{
  "creative_id": "cr_video_catfood_promo_30s",
  "format_id": "video_standard_1080p",
  "content_uri": "https://example.com/assets/catfood_promo_30s.zip"
}
```

## The Submission & Approval Process

### 1. Submitting Creatives (`add_creative_assets`)
Creatives are submitted for a specific media buy using the `add_creative_assets` tool. The publisher's system (the "Creative Engine") then begins processing them.

- **Request**: Contains `media_buy_id`, `package_id`, and a list of `Creative` objects.
- **Response**: Contains a list of `CreativeStatus` objects.

The `CreativeStatus` object includes:
- **`status`**: "pending", "approved", "rejected"
- **`creative_id`**: Unique identifier
- **`review_notes`**: Feedback from review process
- **`estimated_review_time`**: When review will complete

### 2. Auto-Approval

Publishers can configure auto-approval for standard formats:

```json
{
  "creative_engine": {
    "auto_approve_formats": ["display_300x250", "display_728x90"],
    "human_review_required": true
  }
}
```

Creatives matching auto-approved formats bypass human review and are immediately activated.

### 3. Checking Status (`get_creatives`)
The `get_creatives` tool provides comprehensive creative management:

- Filter by media buy, status, or format
- View associations with packages
- Track approval history

### 4. Admin Review (`review_pending_creatives`)

Admin users can review pending creatives:

```json
{
  "creative_id": "cr_video_30s",
  "action": "approve",
  "reason": "Meets brand safety guidelines"
}
```

### 5. Creative Groups

Creatives can be organized into groups for easier management across campaigns:
- Share creatives across multiple media buys
- Rotate creatives within a group
- Apply distribution rules

## Creative Adaptation

A key feature of the protocol is the publisher's ability to suggest adaptations when creatives are submitted. This is useful for optimizing creatives for different placements (e.g., adapting a 16:9 video to a vertical 9:16 format for mobile).

### Automatic Adaptation Suggestions

When creatives are submitted via `add_creative_assets`, the publisher's system may automatically suggest adaptations:

- **Response Enhancement**: The `CreativeStatus` object now includes suggested adaptations
  ```json
  {
    "creative_id": "cr_video_catfood_promo_30s",
    "status": "approved",
    "suggested_adaptations": [
      {
        "adaptation_id": "adapt_vertical_mobile",
        "format_id": "video_vertical_mobile", 
        "name": "Vertical Mobile Version",
        "description": "9:16 vertical version optimized for mobile viewing",
        "changes_summary": [
          "Crop to 9:16 aspect ratio",
          "Focus on cat in first 3 seconds",
          "Add text overlay for sound-off viewing"
        ],
        "rationale": "Mobile inventory performs 40% better with vertical creatives",
        "estimated_performance_lift": 40.0
      }
    ]
  }
  ```

### Approving Adaptations

Buyers can approve suggested adaptations using the `approve_adaptation` tool:

- **Request**: `ApproveAdaptationRequest`
  ```json
  {
    "creative_id": "cr_video_catfood_promo_30s",
    "adaptation_id": "adapt_vertical_mobile",
    "approve": true,
    "modifications": {
      "name": "Cat Food Promo - Mobile Vertical"
    }
  }
  ```
- **Response**: A new creative is created and enters the standard approval workflow
  ```json
  {
    "success": true,
    "new_creative": {
      "creative_id": "cr_video_catfood_promo_vertical_auto",
      "format_id": "video_vertical_mobile",
      "content_uri": "https://publisher.com/adapted/catfood_vertical.mp4"
    },
    "status": {
      "creative_id": "cr_video_catfood_promo_vertical_auto",
      "status": "approved"
    }
  }
  ```

### Benefits of Integrated Adaptation

1. **Proactive Optimization**: Publishers can suggest improvements based on their inventory
2. **Performance-Driven**: Adaptations come with performance estimates
3. **Streamlined Workflow**: No separate tool needed, adaptations are part of the submission flow
4. **Buyer Control**: All adaptations require explicit approval
