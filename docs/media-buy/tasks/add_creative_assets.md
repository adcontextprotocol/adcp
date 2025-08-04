---
title: add_creative_assets
sidebar_position: 4
---

# add_creative_assets

Upload creative assets and assign them to packages. This task includes validation, policy review, and format adaptation suggestions.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `context_id` | string | Yes | Context identifier for session persistence |
| `media_buy_id` | string | Yes | ID of the media buy to add creatives to |
| `assets` | array | Yes | Array of creative assets to upload |
| `assets[].creative_id` | string | Yes | Unique identifier for the creative |
| `assets[].name` | string | Yes | Human-readable creative name |
| `assets[].format` | string | Yes | Creative format type (e.g., `"video"`, `"audio"`, `"display"`) |
| `assets[].media_url` | string | Yes | URL of the creative file |
| `assets[].click_url` | string | No | Landing page URL for the creative |
| `assets[].duration` | number | No | Duration in milliseconds (for video/audio) |
| `assets[].width` | number | No | Width in pixels (for video/display) |
| `assets[].height` | number | No | Height in pixels (for video/display) |
| `assets[].package_assignments` | string[] | Yes | Package IDs to assign this creative to |
| `assets[].assets` | array | No | For multi-asset formats (carousels, sliders) |
| `assets[].assets[].asset_type` | string | Yes | Type of asset (e.g., `"product_image"`, `"logo"`) |
| `assets[].assets[].asset_id` | string | Yes | Unique identifier for the asset |
| `assets[].assets[].content_uri` | string | No | URL for media assets |
| `assets[].assets[].content` | array | No | Text content for text assets |

## Response Format

```json
{
  "message": "string",
  "context_id": "string",
  "asset_statuses": [
    {
      "creative_id": "string",
      "status": "string",
      "platform_id": "string",
      "review_feedback": "string",
      "suggested_adaptations": [
        {
          "adaptation_id": "string",
          "format_id": "string",
          "name": "string",
          "description": "string",
          "changes_summary": ["string"],
          "rationale": "string",
          "estimated_performance_lift": "number"
        }
      ]
    }
  ]
}
```

### Field Descriptions

- **message**: Human-readable summary of the creative upload results
- **context_id**: Context identifier for session persistence
- **asset_statuses**: Array of status information for each uploaded asset
  - **creative_id**: The creative ID from the request
  - **status**: Upload/review status (e.g., `"approved"`, `"pending_review"`, `"rejected"`)
  - **platform_id**: Platform-specific ID assigned to the creative
  - **review_feedback**: Feedback from platform review (if any)
  - **suggested_adaptations**: Array of recommended format adaptations
    - **adaptation_id**: Unique identifier for this adaptation
    - **format_id**: Target format ID for the adaptation
    - **name**: Suggested name for the adapted creative
    - **description**: What this adaptation does
    - **changes_summary**: List of changes that will be made
    - **rationale**: Why this adaptation is recommended
    - **estimated_performance_lift**: Expected performance improvement (percentage)

## Examples

### Example 1: Single Asset Creatives

#### Request
```json
{
  "context_id": "ctx-media-buy-abc123",  // From media buy creation
  "media_buy_id": "gam_1234567890",
  "assets": [
    {
      "creative_id": "pet_food_30s_v1",
      "name": "Purina Pet Food - 30s Spot",
      "format": "video",
      "media_url": "https://cdn.example.com/creatives/pet_food_30s.mp4",
      "click_url": "https://www.purina.com/offers/new-year",
      "duration": 30000,
      "width": 1920,
      "height": 1080,
      "package_assignments": ["pkg_ctv_prime_ca_ny"]
    },
    {
      "creative_id": "pet_food_audio_15s",
      "name": "Purina Audio Spot - 15s",
      "format": "audio",
      "media_url": "https://cdn.example.com/creatives/pet_food_15s.mp3",
      "click_url": "https://www.purina.com/offers",
      "duration": 15000,
      "package_assignments": ["pkg_audio_drive_ca_ny"]
    }
  ]
}
```

### Example 2: Multi-Asset Creative (Carousel)

#### Request
```json
{
  "context_id": "ctx-media-buy-abc123",
  "media_buy_id": "kevel_12345",
  "assets": [
    {
      "creative_id": "cr_carousel_summer_sale",
      "name": "Summer Sale Carousel",
      "format": "display_carousel_5",
      "click_url": "https://example.com/summer-sale",
      "package_assignments": ["pkg_display_retargeting"],
      "assets": [
        {
          "asset_type": "product_image",
          "asset_id": "prod_img_1",
          "content_uri": "https://cdn.example.com/assets/product1.jpg"
        },
        {
          "asset_type": "product_image", 
          "asset_id": "prod_img_2",
          "content_uri": "https://cdn.example.com/assets/product2.jpg"
        },
        {
          "asset_type": "product_image",
          "asset_id": "prod_img_3", 
          "content_uri": "https://cdn.example.com/assets/product3.jpg"
        },
        {
          "asset_type": "product_image",
          "asset_id": "prod_img_4",
          "content_uri": "https://cdn.example.com/assets/product4.jpg"
        },
        {
          "asset_type": "product_image",
          "asset_id": "prod_img_5",
          "content_uri": "https://cdn.example.com/assets/product5.jpg"
        },
        {
          "asset_type": "logo",
          "asset_id": "brand_logo",
          "content_uri": "https://cdn.example.com/assets/logo.png"
        },
        {
          "asset_type": "headline",
          "asset_id": "headlines",
          "content": ["Summer Sale!", "50% Off", "Limited Time", "Shop Now", "Best Deals"]
        }
      ]
    }
  ]
}
```

### Response - All Approved
```json
{
  "message": "Great news! Both creatives have been approved and are now live. Your video is serving on Connected TV and your audio spot is running during drive time. I've identified an opportunity to improve mobile performance by creating a vertical version of your video - this could increase conversions by 35%.",
  "context_id": "ctx-media-buy-abc123",
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
          "changes_summary": [
            "Crop to 9:16 aspect ratio",
            "Add captions for sound-off viewing",
            "Optimize for 6-second view"
          ],
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

### Response - Pending Review
```json
{
  "message": "Your creatives have been uploaded successfully and are in review. The video creative typically takes 2-4 hours for approval, while audio creatives are usually approved within 1 hour. I'll notify you once they're live.",
  "context_id": "ctx-media-buy-abc123",
  "asset_statuses": [
    {
      "creative_id": "pet_food_30s_v1",
      "status": "pending_review",
      "platform_id": "gam_creative_987654",
      "review_feedback": null,
      "suggested_adaptations": []
    },
    {
      "creative_id": "pet_food_audio_15s",
      "status": "pending_review",
      "platform_id": "gam_creative_987655",
      "review_feedback": null,
      "suggested_adaptations": []
    }
  ]
}
```

### Response - Mixed Status with Rejection
```json
{
  "message": "I've processed your creatives with mixed results. The audio spot was approved and is now live. However, the video was rejected due to missing advertiser disclosure. Please add 'Advertisement' text in the first 3 seconds and resubmit. This is a common requirement that ensures transparency.",
  "context_id": "ctx-media-buy-abc123",
  "asset_statuses": [
    {
      "creative_id": "pet_food_30s_v1",
      "status": "rejected",
      "platform_id": "gam_creative_987654",
      "review_feedback": "Missing required advertiser disclosure. Please add 'Advertisement' text in the first 3 seconds of the video.",
      "suggested_adaptations": []
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

## Supported Formats by Platform

Different platforms support different creative formats:

- **Image**: Supported by GAM, Kevel
- **Video**: Supported by GAM, Kevel
- **Audio**: Supported by Triton Digital
- **Custom**: Supported by Kevel (template-based)

## Platform Validation

Platforms validate creatives for:

- **Format compatibility**: Video for CTV, audio for radio, etc.
- **Size and duration limits**: File size, video length, etc.
- **Content policies**: Brand safety, prohibited content
- **Technical specifications**: Codecs, bitrates, resolutions

## Status Values

Creative assets can have the following statuses:

- `approved`: Ready for delivery
- `pending_review`: Under platform review
- `rejected`: Failed validation or policy review
- `processing`: Being transcoded or processed

## Creative Review Process

### Auto-Approval

Publishers can configure auto-approval for standard formats, allowing certain creatives to bypass human review:

```json
{
  "creative_engine": {
    "auto_approve_formats": ["display_300x250", "display_728x90"],
    "human_review_required": true
  }
}
```

Creatives matching auto-approved formats are immediately activated.

### Review States

The creative review process includes several states:
- **pending**: Initial submission, awaiting review
- **approved**: Passed all validations and policy checks
- **rejected**: Failed validation or policy review
- **processing**: Being transcoded or processed

## Usage Notes

- Creatives must be uploaded before the media buy's creative deadline
- Each creative can be assigned to multiple packages
- The platform may suggest format adaptations to improve performance
- Use the `approve_adaptation` tool to accept suggested adaptations (if available)
- Rejected creatives will include feedback in the `review_feedback` field
- Multi-asset creatives (carousels, sliders) use the nested `assets` array
- Some platforms support auto-approval for standard formats